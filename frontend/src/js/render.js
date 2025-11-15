import { videoEl, canvasEl } from './dom.js';
import { clearHotspots, renderHotspot, placeHintOverBox, showHintFor, hideHint, showInfo, videoPointToDisplay } from './ui.js';
import { cropToCanvasFromVideo, embedFromCanvas, hasEmbedModel } from './embedding.js';
import { monumentDB, dbDim, pickLangText, getLang } from './db.js';
import { BACKEND_URL, COSINE_THRESHOLD, DEBUG_FALLBACK_CROP, MAX_BOXES_PER_FRAME, MIN_BOX_SCORE, CROP_SIZE } from './constants.js';

let lastMatches = [];
let lastRecognizedKey = null;
let categoryLogCount = 0;

// Hysteresis and sticky best to reduce flicker
const STICKY_MS = 180; // keep best match visible for 180ms
const HYSTERESIS_DROP = 0.04; // allow small confidence drop to keep sticky
let stickyBest = null; // { entry, confidence, box, until }

// Update placard language live if user toggles EN/IT while scanner is open
try {
  window.addEventListener('storage', (e) => {
    if (!e || e.key !== 'lang') return;
    if (stickyBest && stickyBest.entry) {
      try {
        showInfo(
          stickyBest.entry.name || 'Monument',
          pickLangText(stickyBest.entry.descriptions),
          stickyBest.confidence
        );
      } catch {}
    }
  });
} catch {}


function geojsonHasNearbyPoint(geojson, user, radiusKm = 1.0) {
  if (!geojson || !geojson.type || !user?.lat || !user?.lon) return false;

  const haversineDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const minDistanceToCoords = (coords) => {
    let minDist = Infinity;
    for (const [lon, lat] of coords) {
      const d = haversineDistance(user.lat, user.lon, lat, lon);
      if (d < minDist) minDist = d;
    }
    return minDist;
  };

  const pointInPolygon = (point, polygonCoords) => {
    const [lon, lat] = point;
    const ring = polygonCoords[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect =
        ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  switch (geojson.type) {
    case "Point": {
      const [lon, lat] = geojson.coordinates;
      const dist = haversineDistance(user.lat, user.lon, lat, lon);
      return dist <= radiusKm;
    }

    case "Polygon": {
      const inside = pointInPolygon([user.lon, user.lat], geojson.coordinates);
      if (inside) return true;
      const minDist = minDistanceToCoords(geojson.coordinates[0]);
      return minDist <= radiusKm;
    }

    default:
      return false;
  }
}



// Visual styling constants for bounding box and label placement
const CORNER_LEN_FACTOR = 0.085; // bracket length as fraction of min(w,h)
const CORNER_OFFSET = 6;         // gap between rounded box and corner brackets
const LABEL_GAP_FROM_TL = 8;     // extra gap after the TL bracket so label never overlaps it
const LABEL_TOP_OFFSET = 36;     // vertical distance from box top to label top
const GREEN = '#10b981';         // recognized bbox color

// --- Perf only-console statistics ---
const perfStats = { samples: 0, cropMs: 0, embedMs: 0, matchMs: 0, lastPrint: 0 };
function logPerfIfNeeded() {
  const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // stampa circa ogni 3s (solo console)
  if (t - perfStats.lastPrint > 3000 && perfStats.samples > 0) {
    const s = perfStats;
    const avg = (x) => (x / s.samples).toFixed(2);
    console.log(
      `[Perf] over ${s.samples} samples — crop: ${avg(s.cropMs)} ms, ` +
      `embed: ${avg(s.embedMs)} ms, match: ${avg(s.matchMs)} ms ` +
      `(dbSize=${monumentDB.length}, dim=${dbDim})`
    );
    s.samples = 0; s.cropMs = 0; s.embedMs = 0; s.matchMs = 0; s.lastPrint = t;
  }
}

// --- Remote perf recorder (Option B, opt-in via ?telemetry=1) ---
const __perfRemote = {
  enabled: false,
  sessionId: Math.random().toString(36).slice(2) + Date.now().toString(36),
  t: [], crop: [], embed: [], match: [], dbSize: [], dim: [],
};

function __perfInitRemoteIfRequested() {
  try { const qs = new URLSearchParams(location.search); __perfRemote.enabled = (qs.get('telemetry') === '1'); } catch { __perfRemote.enabled = false; }
  if (__perfRemote.enabled) {
    setInterval(__perfUploadBatch, 10000); // ogni 10s
    try {
      window.addEventListener('pagehide', __perfBeaconFlush, { capture: true });
      window.addEventListener('beforeunload', __perfBeaconFlush, { capture: true });
    } catch {}
    console.log('[Perf] remote logging enabled, session:', __perfRemote.sessionId);
  }
}

async function __perfUploadBatch(reason = 'periodic') {
  if (!__perfRemote.enabled) return;
  const N = __perfRemote.t.length; if (!N) return;
  const meta = {
    tfBackend: (globalThis.tf && globalThis.tf.getBackend ? globalThis.tf.getBackend() : null),
    config: { MAX_BOXES_PER_FRAME, MIN_BOX_SCORE, CROP_SIZE },
    timeNow: new Date().toISOString(),
  };
  const payload = {
    sessionId: __perfRemote.sessionId,
    seq: Date.now(),
    reason,
    meta,
    data: {
      t: __perfRemote.t, crop: __perfRemote.crop, embed: __perfRemote.embed, match: __perfRemote.match,
      dbSize: __perfRemote.dbSize, dim: __perfRemote.dim,
    }
  };
  // svuota buffer dopo la copia
  __perfRemote.t = []; __perfRemote.crop = []; __perfRemote.embed = []; __perfRemote.match = [];
  __perfRemote.dbSize = []; __perfRemote.dim = [];
  try {
    await fetch(`${BACKEND_URL}/log_perf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify(payload) });
  } catch (e) {
    // Re-queue su errore
    const d = payload.data;
    try {
      __perfRemote.t.push(...d.t); __perfRemote.crop.push(...d.crop); __perfRemote.embed.push(...d.embed); __perfRemote.match.push(...d.match);
      __perfRemote.dbSize.push(...d.dbSize); __perfRemote.dim.push(...d.dim);
    } catch {}
    console.warn('[Perf] upload failed, will retry:', e);
  }
}

function __perfBeaconFlush() {
  if (!__perfRemote.enabled) return;
  const N = __perfRemote.t.length; if (!N) return;
  const payload = {
    sessionId: __perfRemote.sessionId, seq: Date.now(), reason: 'unload',
    meta: { timeEnd: new Date().toISOString() },
    data: {
      t: __perfRemote.t, crop: __perfRemote.crop, embed: __perfRemote.embed, match: __perfRemote.match,
      dbSize: __perfRemote.dbSize, dim: __perfRemote.dim,
    }
  };
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    if (!(navigator.sendBeacon && navigator.sendBeacon(`${BACKEND_URL}/log_perf`, blob))) {
      void fetch(`${BACKEND_URL}/log_perf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify(payload) });
    }
  } catch {}
}

// Initialize remote perf if requested
try { __perfInitRemoteIfRequested(); } catch {}

function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

function roundRectPath(ctx, x, y, w, h, r){
  const rr = Math.max(1, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
}

function drawCornerBrackets(ctx, x, y, w, h, len, offset, color){
  const l = Math.max(6, len|0), o = Math.max(0, offset|0);
  ctx.save();
  const baseLW = ctx.lineWidth || 1;
  ctx.lineWidth = Math.max(6, baseLW + 2); /* thicker, bold-like */
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (color) { ctx.strokeStyle = color; }
  ctx.beginPath();
  // TL
  ctx.moveTo(x - o, y + l);
  ctx.lineTo(x - o, y - o);
  ctx.lineTo(x + l, y - o);
  // TR
  ctx.moveTo(x + w - l, y - o);
  ctx.lineTo(x + w + o, y - o);
  ctx.lineTo(x + w + o, y + l);
  // BR
  ctx.moveTo(x + w + o, y + h - l);
  ctx.lineTo(x + w + o, y + h + o);
  ctx.lineTo(x + w - l, y + h + o);
  // BL
  ctx.moveTo(x + l, y + h + o);
  ctx.lineTo(x - o, y + h + o);
  ctx.lineTo(x - o, y + h - l);
  ctx.stroke();
  ctx.restore();
}

function getCornerLen(w, h) {
  return Math.round(Math.min(w, h) * CORNER_LEN_FACTOR);
}

function drawRoundedBox(ctx, x, y, w, h) {
  const r = Math.max(10, Math.min(w, h) * 0.06);
  ctx.save();
  roundRectPath(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1), r);
  // Fill using theme variable-defined fill color (--box-fill)
  ctx.fill();
  ctx.restore();
  // Decorative corner brackets outside the box (slightly offset)
  drawCornerBrackets(ctx, x, y, w, h, getCornerLen(w, h), CORNER_OFFSET);
}

function drawBestGlow(ctx, x, y, w, h, color) {
  // If recognized state requests no perimeter: skip drawing when GREEN is passed
  if (color === GREEN) return;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.shadowBlur = 14;
  if (color) {
    ctx.shadowColor = 'rgba(16,185,129,0.55)'; // green glow
    ctx.strokeStyle = color;
  } else {
    ctx.shadowColor = (getComputedStyle(document.documentElement).getPropertyValue('--box-glow') || 'rgba(217,119,6,0.35)').trim();
    ctx.strokeStyle = (getComputedStyle(document.documentElement).getPropertyValue('--box-glow-strong') || 'rgba(217,119,6,0.85)').trim();
  }
  roundRectPath(ctx, x, y, w, h, Math.max(10, Math.min(w, h) * 0.06));
  ctx.stroke();
  ctx.restore();
}

function drawCrosshair(ctx, x, y, w, h, color) {
  // Draw a centered plus sign inside the box
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  const len = Math.round(Math.min(w, h) * 0.08); // 8% of min dimension
  ctx.save();
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const col = (color || getComputedStyle(document.documentElement).getPropertyValue('--box-color') || '#d97706');
  ctx.strokeStyle = ('' + col).trim();
  ctx.shadowColor = (getComputedStyle(document.documentElement).getPropertyValue('--box-glow') || 'rgba(217,119,6,0.45)').trim();
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(cx - len, cy);
  ctx.lineTo(cx + len, cy);
  ctx.moveTo(cx, cy - len);
  ctx.lineTo(cx, cy + len);
  ctx.stroke();
  ctx.restore();
}

function drawCapsuleLabel(ctx, x, y, text, badge) {
  const padX = 10, padY = 6;
  const dotR = 4; // small status dot radius
  const dotGap = 6; // gap between dot and text
  ctx.save();
  ctx.font = '14px Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  const label = text || '';
  const textW = Math.round(ctx.measureText(label).width);
  const h = 18 + padY * 2;
  // account for the dot inside the chip
  const w = textW + padX * 2 + dotR * 2 + dotGap;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--label-bg') || '#00D4FF';
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--label-fg') || '#072a31';

  // soft shadow behind capsule
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = bg;
  ctx.strokeStyle = 'transparent';
  roundRectPath(ctx, x, y, w, h, 10);
  ctx.fill();

  // turn off shadow for inner elements
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // left green status dot
  ctx.beginPath();
  ctx.fillStyle = '#00E98A';
  ctx.arc(x + padX + dotR, y + h / 2, dotR, 0, Math.PI * 2);
  ctx.fill();

  // text
  ctx.fillStyle = fg;
  ctx.fillText(label, x + padX + dotR * 2 + dotGap, y + padY + 12);
  ctx.restore();
}

function findBestMatch(embedding) {
  if (!monumentDB.length || !embedding || typeof embedding.length !== 'number')
    return null;

  console.log("━━━━━━━━━━━━━━━━━━");
  console.log("🔍 FIND BEST MATCH");
  console.log("Embedding dim:", embedding.length);
  console.log("User coords:", window.userCoords);

  // --- FILTRO GEOLOCALIZZATO ---
  const RADIUS_KM = 0.5;
  const user = window.userCoords;
  let candidates = monumentDB;

  if (user?.lat && user?.lon) {
    try {
      candidates = monumentDB.filter(e =>
        geojsonHasNearbyPoint(e.location_coords, user, RADIUS_KM)
      );
      console.log(`🌍 Filtrate ${candidates.length} opere vicine (${RADIUS_KM} km)`);
    } catch (err) {
      console.warn('Errore filtro geolocalizzato:', err);
      candidates = monumentDB;
    }
  } else {
    console.log('⚠️ Nessuna posizione: confronto con TUTTI i monumenti');
  }

  if (!candidates.length) {
    console.warn('❌ Nessun candidato dopo filtro geolocalizzato');
    return null;
  }

  console.log(`📚 Monumenti candidati: ${candidates.length}`);

  // --- MATCHING ---
  const dim = embedding.length;
  let bestIdx = -1;
  let bestSim = -1.0;

  console.log("📊 Similarità con tutti i candidati:");
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    const vec = e.embedding;

    if (!vec || vec.length !== dim) {
      console.warn(`  ❌ Skip ${e.name} (dim errata)`);
      continue;
    }

    // cosine similarity
    let s = 0.0;
    for (let j = 0; j < dim; j++) s += embedding[j] * vec[j];

    // calcolo norma per debug
    let normDB = Math.sqrt(vec.reduce((acc, x) => acc + x*x, 0));
    let normEmbed = Math.sqrt(embedding.reduce((acc, x) => acc + x*x, 0));

    console.log(
      `  • ${e.name} (id=${e.id}) → sim=${s.toFixed(4)}, normDB=${normDB.toFixed(4)}, normIn=${normEmbed.toFixed(4)}`
    );

    if (s > bestSim) {
      bestSim = s;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) {
    console.log("❌ Nessuna similarità valida");
    return null;
  }

  const entry = candidates[bestIdx];

  console.log("🏆 Best match:");
  console.log(`    → ${entry.name} (id=${entry.id})`);
  console.log(`    → similarity = ${bestSim.toFixed(4)}`);
  console.log("━━━━━━━━━━━━━━━━━━");

  return { entry, confidence: bestSim };
}



export async function drawDetections(ctx, result, onHotspotClick) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;

  // Clear full canvas (device-pixel aware)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.restore();

  const lw = 4;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = (getComputedStyle(document.documentElement).getPropertyValue('--box-color') || '#d97706').trim();
  ctx.fillStyle = (getComputedStyle(document.documentElement).getPropertyValue('--box-fill') || 'rgba(217,119,6,0.12)').trim();
  ctx.font = '14px Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  lastMatches = [];

  if (!result?.detections?.length) {
    lastMatches = [];
    let fallbackMatched = false;
    if (DEBUG_FALLBACK_CROP && hasEmbedModel()) {
      try {
        const box = { originX: w * 0.25, originY: h * 0.25, width: w * 0.5, height: h * 0.5 };
        const crop = cropToCanvasFromVideo(box);
        const emb = embedFromCanvas(crop);
        const matched = findBestMatch(emb);
        if (matched && matched.confidence >= COSINE_THRESHOLD) {
          const { entry, confidence } = matched;
          lastMatches.push({ entry, confidence, box });
          fallbackMatched = true;

          drawRoundedBox(ctx, box.originX, box.originY, box.width, box.height);
          // premium glow for the matched box (green)
          drawBestGlow(ctx, box.originX, box.originY, box.width, box.height, GREEN);
          // overlay green brackets and crosshair to indicate recognition
          drawCornerBrackets(ctx, box.originX, box.originY, box.width, box.height, getCornerLen(box.width, box.height), CORNER_OFFSET, GREEN);


          // Show placard with localized description
          try { showInfo(entry.name || 'Monument', pickLangText(entry.descriptions), confidence); } catch {}

          const key = (entry && (entry.id != null ? String(entry.id) : (entry.name || '')));
          if (key && key !== lastRecognizedKey) {
            lastRecognizedKey = key;
            showHintFor(entry, box);
          }
          renderHotspot({ entry, confidence, box }, onHotspotClick);
          updateRecognitionLabels(lastMatches, onHotspotClick);
        }
      } catch (e) { console.warn('Fallback match failed:', e); }
    }
    if (!fallbackMatched) {
      lastRecognizedKey = null;
      hideHint();
      showInfo(null);
      clearHotspots();
      updateRecognitionLabels([], onHotspotClick);
    }
    return;
  }

  let anyMatch = false;

  // Filter detections by score and limit to top-N
  const filtered = (result.detections || [])
    .map(d => ({ det: d, score: d.categories?.[0]?.score ?? 0 }))
    .filter(x => x.score >= MIN_BOX_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_BOXES_PER_FRAME);

  // Draw rounded boxes per detection with pixel-aligned coords
  for (const { det } of filtered) {
    const box = det.boundingBox;
    const rawX = box.originX; const rawY = box.originY;
    const rawW = box.width;   const rawH = box.height;
    const x1 = Math.max(0, Math.min(w, rawX));
    const y1 = Math.max(0, Math.min(h, rawY));
    const x2 = Math.max(0, Math.min(w, rawX + rawW));
    const y2 = Math.max(0, Math.min(h, rawY + rawH));
    let x = Math.round(Math.min(x1, x2));
    let y = Math.round(Math.min(y1, y2));
    let rw = Math.round(Math.abs(x2 - x1));
    let rh = Math.round(Math.abs(y2 - y1));
    rw = Math.max(1, rw);
    rh = Math.max(1, rh);
    det.__alignedBox = { originX: x, originY: y, width: rw, height: rh };
    drawRoundedBox(ctx, x, y, rw, rh);
  }

  // Labels and matching per detection (limited set)
  for (const { det } of filtered) {
    const cat = det.categories?.[0];
    const box = det.__alignedBox || det.boundingBox;
    if (cat) {
      if (categoryLogCount < 8) {
        try { console.log('Detected categories:', det.categories?.map(c => ({ name: c.categoryName, score: c.score }))); } catch {}
        categoryLogCount++;
      }
      let name = cat.categoryName || 'Monument';
      let uiLabel = ``;
      let matched = null;

      try {
        if (hasEmbedModel()) {
          const t0 = performance.now();
          const crop = cropToCanvasFromVideo(det.boundingBox);
          const t1 = performance.now();
          const emb = embedFromCanvas(crop);
          const t2 = performance.now();
          const matchedLocal = findBestMatch(emb);
          const t3 = performance.now();

          perfStats.samples++;
          perfStats.cropMs  += (t1 - t0);
          perfStats.embedMs += (t2 - t1);
          perfStats.matchMs += (t3 - t2);
          logPerfIfNeeded();

          // Remote telemetry (Option B): buffer this sample if enabled
          try {
            if (__perfRemote && __perfRemote.enabled) {
              __perfRemote.t.push(Date.now());
              __perfRemote.crop.push(t1 - t0);
              __perfRemote.embed.push(t2 - t1);
              __perfRemote.match.push(t3 - t2);
              __perfRemote.dbSize.push(monumentDB.length || 0);
              __perfRemote.dim.push(dbDim || 0);
            }
          } catch {}

          matched = matchedLocal;
        }
      } catch (e) {
        console.warn('Embedding/match failed:', e);
      }

      if (matched && matched.confidence >= COSINE_THRESHOLD) {
        const { entry, confidence } = matched;
        uiLabel = `${entry.name || 'Monument'}`; // name only; confidence shown in badge
        const hitBox = det.__alignedBox || det.boundingBox;
        lastMatches.push({ entry, confidence, box: hitBox });
        anyMatch = true;
        // Overlay green styling to indicate recognized monument
        drawCornerBrackets(ctx, box.originX, box.originY, box.width, box.height, getCornerLen(box.width, box.height), CORNER_OFFSET, GREEN);
      }

    }
  }

  const t = nowMs();
  if (lastMatches && lastMatches.length) {
    let best = lastMatches[0];
    for (const m of lastMatches) if (m.confidence > best.confidence) best = m;
    stickyBest = { entry: best.entry, confidence: best.confidence, box: best.box, until: t + STICKY_MS };
    // Glow highlight on best (green)
    drawBestGlow(ctx, best.box.originX, best.box.originY, best.box.width, best.box.height, GREEN);
    // Green corner brackets and crosshair on best
    drawCornerBrackets(ctx, best.box.originX, best.box.originY, best.box.width, best.box.height, getCornerLen(best.box.width, best.box.height), CORNER_OFFSET, GREEN);
    // Hotspot and hint for current best
    renderHotspot(best, onHotspotClick);
    // Update recognition labels for all matches
    updateRecognitionLabels(lastMatches, onHotspotClick);
    placeHintOverBox(best.box);
    try { showInfo(best.entry.name || 'Monument', pickLangText(best.entry.descriptions), best.confidence); } catch {}
    const key = (best.entry && (best.entry.id != null ? String(best.entry.id) : (best.entry.name || '')));
    if (key && key !== lastRecognizedKey) {
      lastRecognizedKey = key;
      showHintFor(best.entry, best.box);
    }
    // Show placard with localized description
  } else if (stickyBest && t < stickyBest.until && stickyBest.confidence >= (COSINE_THRESHOLD - HYSTERESIS_DROP)) {
    // Keep last best briefly to avoid flicker
    const b = stickyBest;
    drawBestGlow(ctx, b.box.originX, b.box.originY, b.box.width, b.box.height, GREEN);
    drawCornerBrackets(ctx, b.box.originX, b.box.originY, b.box.width, b.box.height, getCornerLen(b.box.width, b.box.height), CORNER_OFFSET, GREEN);
    updateRecognitionLabels([b], onHotspotClick);
  } else {
    stickyBest = null;
    lastRecognizedKey = null;
    hideHint();
    showInfo(null);
    clearHotspots();
    updateRecognitionLabels([], onHotspotClick);
  }
}

export function getLastMatches() {
  return lastMatches;
}

export function resetRenderState() {
  lastMatches = [];
  lastRecognizedKey = null;
}


// Render/update pill labels ("Tocca") below recognized bboxes
function updateRecognitionLabels(matches, onClick) {
  try {
    const host = document.getElementById('bboxLabels');
    if (!host) return;

    if (!matches || !matches.length) {
      host.setAttribute('aria-hidden', 'true');
      host.innerHTML = '';
      return;
    }
    host.setAttribute('aria-hidden', 'false');

    const lang = (typeof getLang === 'function' ? getLang() : 'it');
    const labelText = lang === 'en' ? 'Tap' : 'Tocca';
    const ariaText = lang === 'en' ? 'Tap for info' : 'Tocca per info';

    const wantedKeys = new Set();
    const children = Array.from(host.children);

    for (const m of matches) {
      if (!m || !m.box) continue;
      const cx = (m.box.originX || 0) + (m.box.width || 0) / 2;
      const by = (m.box.originY || 0) + (m.box.height || 0);
      const pt = videoPointToDisplay(cx, by);
      const dpX = pt.x;
      const dpY = pt.y + 12; // place below bbox with margin
      const key = (m.entry && (m.entry.id != null ? String(m.entry.id) : (m.entry.name || ''))) || `${Math.round(cx)}x${Math.round(by)}`;
      wantedKeys.add(key);

      // Try to reuse existing element by key
      let el = children.find(ch => ch && ch.dataset && ch.dataset.key === key);
      if (el) {
        // Update position only to keep animation running
        el.style.left = `${dpX}px`;
        el.style.top = `${dpY}px`;
      } else {
        // Create new label once
        el = document.createElement('div');
        el.className = 'rec-label';
        el.dataset.key = key;
        el.style.left = `${dpX}px`;
        el.style.top = `${dpY}px`;
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', ariaText);

        // Eye icon
        el.insertAdjacentHTML('beforeend',
          '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n' +
          '  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path>\n' +
          '  <circle cx="12" cy="12" r="3"></circle>\n' +
          '</svg>'
        );
        // Text
        const span = document.createElement('span');
        span.textContent = labelText;
        el.appendChild(span);
        // Info icon
        el.insertAdjacentHTML('beforeend',
          '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n' +
          '  <circle cx="12" cy="12" r="10"></circle>\n' +
          '  <path d="M12 16v-4"></path>\n' +
          '  <path d="M12 8h.01"></path>\n' +
          '</svg>'
        );

        const handle = (ev) => {
          try { ev.preventDefault(); ev.stopPropagation(); } catch {}
          if (typeof onClick === 'function') onClick(m.entry, m.confidence);
        };
        el.addEventListener('click', handle, { passive: false });
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') handle(ev); });

        host.appendChild(el);
      }
    }

    // Remove labels that are no longer needed
    for (const ch of Array.from(host.children)) {
      const k = ch && ch.dataset ? ch.dataset.key : undefined;
      if (!k || !wantedKeys.has(k)) ch.remove();
    }
  } catch (e) { /* noop */ }
}


// --- Console benchmark for pure matching loop ---
export async function benchmarkMatchLoop(iterations = 200, warmup = 20) {
  if (!monumentDB.length || !dbDim) {
    console.warn('DB non caricato o dim sconosciuta');
    return;
  }
  function randomUnitVec(d) {
    const arr = new Float32Array(d);
    for (let i = 0; i < d; i++) arr[i] = Math.random() - 0.5;
    let norm = 0; for (let i = 0; i < d; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm); for (let i = 0; i < d; i++) arr[i] /= norm || 1;
    return Array.from(arr);
  }
  // Warmup
  for (let i = 0; i < warmup; i++) findBestMatch(randomUnitVec(dbDim));
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const q = randomUnitVec(dbDim);
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    findBestMatch(q);
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    times.push(t1 - t0);
    // allow UI to breathe
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 0));
  }
  times.sort((a,b)=>a-b);
  const N = times.length;
  const mean = times.reduce((a,b)=>a+b,0)/N;
  const p = (x) => times[Math.floor(x*(N-1))];
  const p50 = p(0.50), p90 = p(0.90), p95 = p(0.95), p99 = p(0.99);
  console.log(`[Bench Match] N=${N} mean=${mean.toFixed(3)}ms p50=${p50.toFixed(3)} p90=${p90.toFixed(3)} p95=${p95.toFixed(3)} p99=${p99.toFixed(3)} | DB=${monumentDB.length} dim=${dbDim}`);
  try { if (typeof window !== 'undefined') window.__lastBenchMatch = { mean, p50, p90, p95, p99, N, dbSize: monumentDB.length, dim: dbDim }; } catch {}
  return { mean, p50, p90, p95, p99, N, dbSize: monumentDB.length, dim: dbDim };
}

// Expose to window for easier Console access
try { if (typeof window !== 'undefined') window.benchmarkMatchLoop = benchmarkMatchLoop; } catch {}

import { appEl, videoEl, canvasEl, hudEl, startBtn, statusEl, infoEl, detailEl, detailNameEl, detailMetaEl, detailBodyEl, detailArtistEl, detailYearEl, detailMuseumEl, detailLocationEl, closeDetailBtn, backBtn } from './dom.js';
import { status as setStatus, showInfo, hideHint, clearHotspots, clientPointToVideo, pointInBox } from './ui.js';
import { initDetector, detector, closeDetector } from './detection.js';
import { initEmbeddingModel } from './embedding.js';
import { loadMonumentDB, pickLangText, getLang, setLang } from './db.js';
import { drawDetections, getLastMatches, resetRenderState } from './render.js';


let userCoords = null;
window.userCoords = userCoords;
let userMarkerFeature = null;

async function getUserPosition(countdownMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject("Geolocation non supportata");
      return;
    }

    let bestPos = null;
    let permissionDenied = false;
    let resolved = false;

    function onSuccess(pos) {
      const { latitude, longitude, accuracy } = pos.coords;
      console.log(`→ Nuova posizione: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (accuracy ${accuracy}m)`);

      // Aggiorna solo se la posizione è abbastanza precisa
      if (accuracy < 50) {
        userCoords = { lat: latitude, lon: longitude, acc: accuracy };
        window.userCoords = userCoords;
      } else {
        // Posizione troppo imprecisa → NON accettare
        console.log("❌ Posizione scartata: accuratezza troppo bassa (" + accuracy + "m)");
      }


      // Mantiene la più precisa come best
      if (!bestPos || accuracy < bestPos.coords.accuracy) {
        bestPos = pos;
      }

      // Risolvi appena arriva una posizione abbastanza precisa (<50m)
      if (!resolved && accuracy < 50) {
        resolved = true;
        console.log("✅ Fix GPS preciso ottenuto:", userCoords);
        resolve(userCoords);
      }

      if (window.userMarkerFeature && window.detailMapInstance) {
        if (accuracy < 50) {
          const coords = ol.proj.fromLonLat([longitude, latitude]);
          window.userMarkerFeature.getGeometry().setCoordinates(coords);
        } else {
          console.log("❌ Marker non aggiornato: posizione imprecisa");
        }
      }
    }

    function onError(err) {
      console.warn("Errore GPS:", err);
      if (err.code === err.PERMISSION_DENIED) {
        permissionDenied = true;
        resolved = true;
        console.warn("🚫 Permesso posizione negato");

        window.userCoords = null;
        userCoords = null;

        resolve(null);
      }
    }

    // 🔁 Attiva un solo watcher continuo globale
    if (!window.userWatchId) {
      window.userWatchId = navigator.geolocation.watchPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
      });
    }

    // Timeout di sicurezza (se non arriva un fix buono)
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (bestPos && bestPos.coords.accuracy < 50) {
          // buona posizione → accetta
          const { latitude, longitude, accuracy } = bestPos.coords;
          userCoords = { lat: latitude, lon: longitude, acc: accuracy };
          resolve(userCoords);
        } else {
          // nessuna posizione abbastanza precisa → ritorna null
          console.log("❌ Nessuna posizione precisa trovata");

          window.userCoords = null;
          userCoords = null;

          resolve(null);
        }
      }
    }, countdownMs + 500);
  });
}


function stopUserTracking() {
  if (window.userWatchId) {
    navigator.geolocation.clearWatch(window.userWatchId);
    console.log("🛑 Tracciamento GPS interrotto");
    window.userWatchId = null;
  }
}


// Language toggle setup
// Minimal i18n dictionary helper so we can reuse strings outside applyLanguageToUI
function getI18n(lang) {
  const L = (lang || getLang() || 'it').slice(0,2).toLowerCase();
  const dict = {
    it: {
      // Scanner UI strings
      title: "Scopri i monumenti intorno a te",
      status: "Inquadra i monumenti con la fotocamera",
      start: "Avvia",
      back: "Indietro",
      activation: {
        title: "Avvio del sistema di riconoscimento",
        subHTML: "Preparati a <span class=\"accent\">inquadrare il monumento</span> con la fotocamera",
        permNeeded: "Autorizzazione fotocamera necessaria"
      },
      scannerHeader: { title: "Scansione monumento" },
      detail: {
        artist: "Artista",
        year: "Anno",
        description: "Descrizione",
        close: "Chiudi"
      },
      // Homepage strings
      home: {
        subtitle: "Scopri i monumenti di Forlì",
        scan: "Scansiona Monumento",
        curator: "Accesso Gestore",
        foot: "Basato su un sistema di riconoscimento AI",
      }
    },
    en: {
      title: "Discover monuments around you",
      status: "Point the camera at monuments",
      start: "Start",
      back: "Back",
      activation: {
        title: "Starting the recognition system",
        subHTML: "Get ready to <span class=\"accent\">frame the monument</span> in your camera view",
        permNeeded: "Camera permission needed"
      },
      scannerHeader: { title: "Scan monument" },
      detail: {
        artist: "Artist",
        year: "Year",
        description: "Description",
        close: "Close"
      },
      home: {
        subtitle: "Discover the monuments of Forlì",
        scan: "Scan Monument",
        curator: "Manager Login",
        foot: "Powered by AI recognition system",
      }
    }
  };
  return dict[L] || dict.it;
}

function initLanguageToggle() {
  const current = getLang();
  const btnIt = document.querySelector('.lang-toggle button[data-lang="it"]');
  const btnEn = document.querySelector('.lang-toggle button[data-lang="en"]');
  const all = [btnIt, btnEn].filter(Boolean);
  function updateActive() {
    const lang = getLang();
    all.forEach(b => {
      if (!b) return;
      const isActive = b.dataset.lang === lang;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', String(isActive));
    });
  }
  all.forEach(b => b && b.addEventListener('click', () => {
    const chosen = b.dataset.lang;
    setLang(chosen);
    updateActive();
    applyLanguageToUI();
  }));
  updateActive();
}

function applyLanguageToUI() {
  const lang = getLang();
  const t = getI18n(lang);

  // Set <html lang=".."> for accessibility/SEO
  try { document.documentElement.setAttribute('lang', (lang === 'en' ? 'en' : 'it')); } catch {}

  // Scanner UI (if present)
  const titleEl = document.querySelector('.card-title');
  if (titleEl && t.title) titleEl.textContent = t.title;
  if (statusEl && t.status) statusEl.textContent = t.status;
  if (startBtn && t.start) startBtn.textContent = t.start;
  if (backBtn && t.back) backBtn.textContent = t.back;

  // Activation overlay localization (scanner page)
  const activateTitleEl = document.getElementById('activateTitle');
  const activateSubEl = document.querySelector('.activate-sub');
  if (activateTitleEl && t.activation?.title) {
    activateTitleEl.textContent = t.activation.title;
  }
  if (activateSubEl && t.activation?.subHTML) {
    activateSubEl.innerHTML = t.activation.subHTML;
  }

  // Scanner header title localization
  const scannerHeaderTitle = document.querySelector('.camera-header .header-title span');
  if (scannerHeaderTitle && t.scannerHeader?.title) {
    scannerHeaderTitle.textContent = t.scannerHeader.title;
  }

  // Detail sheet localization (if present)
  const detailCard = document.querySelector('.detail-card');
  if (detailCard && t.detail) {
    try {
      const rows = detailCard.querySelectorAll('.detail-rows .row');
      // Expecting order: Artist, Year
      if (rows[0]) rows[0].querySelector('.chip').textContent = t.detail.artist || 'Artist';
      if (rows[1]) rows[1].querySelector('.chip').textContent = t.detail.year || 'Year';
      // Description label is in a separate row directly under .detail-card
      const descChipEl = detailCard.querySelector(':scope > .row .chip');
      if (descChipEl && t.detail.description) descChipEl.textContent = t.detail.description;
    } catch {}
    // Close button label
    const closeBtn = document.getElementById('closeDetailBtn');
    if (closeBtn && t.detail.close) { closeBtn.setAttribute('title', t.detail.close); closeBtn.setAttribute('aria-label', t.detail.close); }
  }

  // Homepage UI (gate on presence of #scanBtn)
  const scanBtnEl = document.getElementById('scanBtn');
  if (scanBtnEl && t.home) {
    const subtitleEl = document.querySelector('.card > p.subtitle');
    const curatorBtnEl = document.getElementById('curatorBtn');
    const scanLabelEl = scanBtnEl.querySelector('span:last-child');
    const curatorLabelEl = curatorBtnEl ? curatorBtnEl.querySelector('span:last-child') : null;
    const footEl = document.querySelector('.card .foot');
    if (subtitleEl && t.home.subtitle) subtitleEl.textContent = t.home.subtitle;
    if (scanLabelEl && t.home.scan) scanLabelEl.textContent = t.home.scan;
    if (curatorLabelEl && t.home.curator) curatorLabelEl.textContent = t.home.curator;
    if (footEl && t.home.foot) footEl.textContent = t.home.foot;
  }
}

// Bottom sheet gestures (swipe-to-close)
function initBottomSheetGestures() {
  const sheet = document.querySelector('.detail-card');
  if (!sheet) return;
  let dragging = false;
  let startY = 0;
  let lastY = 0;
  let hasMoved = false;

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Only start drag if at top of scroll
    if (sheet.scrollTop > 0) return;
    dragging = true;
    hasMoved = false;
    startY = (e.touches ? e.touches[0].clientY : e.clientY) || 0;
    lastY = startY;
    sheet.style.transition = 'none';
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: true, once: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true, once: true });
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) || 0;
    const dy = Math.max(0, y - startY);
    if (dy > 2) hasMoved = true;
    // Prevent page scroll while dragging sheet
    try { e.preventDefault(); } catch {}
    sheet.style.transform = `translateY(${dy}px)`;
  };

  const onPointerUp = (e) => {
    window.removeEventListener('pointermove', onPointerMove, { passive: false });
    dragging = false;
    const endY = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) || lastY;
    const dy = Math.max(0, endY - startY);
    sheet.style.transition = '';
    if (dy > 120) {
      // Close
      sheet.style.transform = `translateY(100vh)`;
      setTimeout(() => { try { sheet.style.transform = ''; } catch {}; try { closeDetail(); } catch {}; }, 180);
    } else {
      // Snap back
      sheet.style.transform = 'translateY(0)';
    }
  };

  // Use pointer events when available
  sheet.addEventListener('pointerdown', onPointerDown, { passive: true });
}

// Initialize language on module load
initLanguageToggle();
applyLanguageToUI();
initBottomSheetGestures();

let stream = null;
let running = false;
let lastVideoTime = -1;
let lastInferTime = 0;
const INFER_INTERVAL_MS = 90; // ~11 Hz throttling to reduce load and artifacts

function status(msg) {
  setStatus(statusEl, msg);
}

function openDetail(entry, confidence) {
  try { infoEl.style.display = 'none'; } catch {}
  hideHint();
  clearHotspots();
  if (detailNameEl) detailNameEl.textContent = entry?.name || 'Opera';

  const setField = (el, val) => {
    if (!el) return;
    const row = el.closest ? el.closest('.row') : null;
    if (val == null || val === '') {
      el.textContent = '';
      if (row) row.style.display = 'none';
    } else {
      el.textContent = String(val);
      if (row) row.style.display = '';
    }
  };

  setField(detailArtistEl, entry?.artist || '');
  setField(detailYearEl, entry?.year || '');

  const desc = entry?.descriptions ? (pickLangText(entry.descriptions) || '') : (entry?.description || '');
  if (detailBodyEl) detailBodyEl.textContent = desc;

  // Mostra la mappa solo se la posizione utente è disponibile
  const mapEl = document.getElementById("detailMap");

  if (userCoords && userCoords.lat && userCoords.lon) {
    // Assicuriamoci di ripristinare visibilità se erano stati nascosti in precedenza
    if (mapEl) {
      // Row "Mappa" (elemento subito prima della mappa nel DOM)
      const rowMappa = mapEl.previousElementSibling;
      if (rowMappa && rowMappa.classList.contains('row')) rowMappa.style.display = '';

      // Separatore sopra la row "Mappa" (due elementi prima della mappa)
      const sep = rowMappa?.previousElementSibling;
      if (sep && sep.classList.contains('detail-sep')) sep.style.display = '';

      // Mostra mappa
      mapEl.style.display = '';
    }

    initDetailMap(entry.location_coords, userCoords);
    startLiveUserTracking();
  } else {
    // Utente NON ha dato la posizione → nascondi mappa + label + separatore
    if (!mapEl) {
      // safety: niente da fare se manca l'elemento
    } else {
      // Nascondi la mappa
      mapEl.style.display = "none";

      // Row "Mappa" è l'elemento subito prima della mappa
      const rowMappa = mapEl.previousElementSibling;
      if (rowMappa && rowMappa.classList.contains('row')) {
        rowMappa.style.display = "none";
      }

      // Il separatore è quello sopra la row "Mappa"
      const sep = rowMappa?.previousElementSibling;
      if (sep && sep.classList.contains('detail-sep')) {
        sep.style.display = "none";
      }
    }
  }

  if (detailEl) {
    detailEl.classList.remove('hidden', 'closing');
    // Force reflow to ensure animation restarts
    void detailEl.offsetWidth;
    detailEl.classList.add('open');
  }
  // Ensure the sheet starts from top and is fully visible when content fits
  try {
    const sheet = document.querySelector('.detail-card');
    if (sheet) { sheet.scrollTop = 0; sheet.style.transform = ''; }
  } catch {}
  running = false;
  try { const ctx = canvasEl.getContext('2d'); ctx.clearRect(0, 0, canvasEl.width, canvasEl.height); } catch {}
}

function initDetailMap(geojson, userCoords) {
  const mapEl = document.getElementById("detailMap");
  if (!mapEl) return;

  // Se c'è già una mappa, distruggila
  if (window.detailMapInstance) {
    try { window.detailMapInstance.setTarget(null); } catch {}
    window.detailMapInstance = null;
  }

  // Crea nuova mappa
  const map = new ol.Map({
    target: mapEl,
    layers: [new ol.layer.Tile({ source: new ol.source.OSM() })],
    view: new ol.View({
      center: ol.proj.fromLonLat([12.0409, 44.2220]), // Forlì
      zoom: 17,
    }),
    controls: [],
    interactions: [],
  });
  window.detailMapInstance = map;

  const vectorSrc = new ol.source.Vector();
  const vectorLayer = new ol.layer.Vector({ source: vectorSrc });
  map.addLayer(vectorLayer);

  const extentFeatures = []; // 👈 raccogliamo le geometrie per calcolare il bounding box totale

  // === Monumento ===
  if (geojson) {
    try {
      const g = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
      if (g.type === "Polygon" && g.coordinates?.[0]) {
        const coords = g.coordinates[0].map(([lon, lat]) => ol.proj.fromLonLat([lon, lat]));
        const polygon = new ol.geom.Polygon([coords]);
        const feature = new ol.Feature(polygon);
        feature.setStyle(new ol.style.Style({
          stroke: new ol.style.Stroke({ color: "#d91c1c", width: 2 }),
          fill: new ol.style.Fill({ color: "rgba(217,28,28,0.2)" }),
        }));
        vectorSrc.addFeature(feature);
        extentFeatures.push(feature);

        window.monumentFeature = feature;

      } else if (g.type === "Point" && g.coordinates) {
        const [lon, lat] = g.coordinates;
        const point = new ol.geom.Point(ol.proj.fromLonLat([lon, lat]));
        const feature = new ol.Feature(point);
        feature.setStyle(new ol.style.Style({
          image: new ol.style.Circle({
            radius: 6,
            fill: new ol.style.Fill({ color: "#d91c1c" }),
            stroke: new ol.style.Stroke({ color: "#fff", width: 2 }),
          }),
        }));
        vectorSrc.addFeature(feature);
        extentFeatures.push(feature);

        window.monumentFeature = feature;

      }
    } catch (e) {
      console.warn("Invalid GeoJSON:", e);
    }
  }

  // === Punto utente ===
  if (userCoords?.lon && userCoords?.lat) {
    userMarkerFeature = new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat([userCoords.lon, userCoords.lat])));
    userMarkerFeature.setStyle(new ol.style.Style({
      image: new ol.style.Circle({
        radius: 9,
        fill: new ol.style.Fill({ color: "#007aff" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 2 }),
      }),
    }));
    vectorSrc.addFeature(userMarkerFeature);
    extentFeatures.push(userMarkerFeature);
  }

  // === Adatta la vista all'insieme di tutte le geometrie ===
  if (extentFeatures.length > 0) {
    const extent = ol.extent.createEmpty();
    extentFeatures.forEach(f => ol.extent.extend(extent, f.getGeometry().getExtent()));
    map.getView().fit(extent, {
      padding: [40, 40, 40, 40],
      maxZoom: 17,
      duration: 600,
    });
  }

  // Aggiorna dimensione mappa dopo un breve delay
  setTimeout(() => {
    if (window.detailMapInstance) {
      window.detailMapInstance.updateSize();
    }
  }, 400);
}


function startLiveUserTracking() {
  if (!window.detailMapInstance || !window.monumentFeature || !userMarkerFeature) return;

  // Aggiorna il marker e la vista ogni 2 secondi usando la posizione globale
  const update = () => {
    if (!userCoords || !userCoords.lat || !userCoords.lon) return;
    const target = ol.proj.fromLonLat([userCoords.lon, userCoords.lat]);
    const geom = userMarkerFeature.getGeometry();

    // Smooth marker animation
    const current = geom.getCoordinates();
    const duration = 800;
    let t0 = null;
    const step = (ts) => {
      if (!t0) t0 = ts;
      const p = Math.min((ts - t0) / duration, 1);
      geom.setCoordinates([
        current[0] + (target[0] - current[0]) * p,
        current[1] + (target[1] - current[1]) * p,
      ]);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);

    // Auto-zoom + follow tra user e monumento
    const extent = ol.extent.createEmpty();
    ol.extent.extend(extent, userMarkerFeature.getGeometry().getExtent());
    ol.extent.extend(extent, window.monumentFeature.getGeometry().getExtent());
    window.detailMapInstance.getView().fit(extent, {
      padding: [40, 40, 40, 40],
      maxZoom: 21,
      minZoom: 16,
      duration: 600,
    });
  };

  // aggiorna periodicamente (non crea nuovi watcher!)
  if (window.mapFollowInterval) clearInterval(window.mapFollowInterval);
  window.mapFollowInterval = setInterval(update, 2000);
}



function closeDetail() {
  if (detailEl) {

    detailEl.classList.remove('open');
    detailEl.classList.add('closing');
    const end = () => {
      detailEl.classList.add('hidden');
      detailEl.classList.remove('closing');
      try { detailEl.removeEventListener('animationend', end); } catch {}
    };
    try { detailEl.addEventListener('animationend', end, { once: true }); } catch {}
    // Fallback in case animationend doesn't fire
    setTimeout(() => { try { end(); } catch {} }, 260);
  }
  try { hideHint(); } catch {}
  try { showInfo(null); } catch {}
  try { clearHotspots(); } catch {}
  resetRenderState();
  if (!running) { running = true; startLoop(); }
}

backBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  if (typeof e.stopPropagation === 'function') e.stopPropagation();
  closeDetail();
});

closeDetailBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  if (typeof e.stopPropagation === 'function') e.stopPropagation();
  closeDetail();
});

appEl?.addEventListener('click', (ev) => {
  if (!running) return;
  const matches = getLastMatches();
  if (!matches || !matches.length) return;
  const pt = clientPointToVideo(ev.clientX, ev.clientY);
  let best = null;
  for (const m of matches) {
    if (pointInBox(pt.x, pt.y, m.box, 8)) {
      if (!best || m.confidence > best.confidence) best = m;
    }
  }
  if (best) openDetail(best.entry, best.confidence);
});

async function runStartup() {
  if (running || stream) return;
  if (startBtn) startBtn.disabled = true;

  window.userCoords = null;
  userCoords = null;


  // Activation overlay elements (present only on scanner page)
  const activate = document.getElementById('activate');
  const cnt = document.getElementById('activateCountdown');
  const bar = document.getElementById('activateBar');

  function startCountdown(ms = 15000) {
    if (!activate) return Promise.resolve();
    activate.classList.remove('hidden');
    const totalSteps = Math.max(1, Math.ceil(ms / 1000)); // e.g., 3s -> 3 steps
    if (cnt) cnt.textContent = String(totalSteps);
    if (bar) bar.style.width = '0%';
    const t0 = performance.now();
    let lastShown = totalSteps;
    return new Promise((resolve) => {
      function tick(now) {
        const elapsed = Math.max(0, now - t0);
        const left = Math.max(0, ms - elapsed);
        const sec = Math.ceil(left / 1000); // N -> ... -> 1 -> 0
        const show = Math.min(totalSteps, Math.max(1, sec || 1));
        // Update number only when it changes
        if (cnt && show !== lastShown) {
          cnt.textContent = String(show);
          lastShown = show;
          // Step the bar forward by one segment per decrement
          if (bar) {
            const completed = (totalSteps - show); // 0 .. totalSteps-1
            const pctStep = (completed / totalSteps) * 100;
            bar.style.width = pctStep.toFixed(2) + '%';
          }
        }
        // Keep ticking until the end
        if (elapsed < ms) {
          requestAnimationFrame(tick);
        } else {
          // Finalize: fill the bar completely at countdown end
          if (bar) bar.style.width = '100%';
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  function hideActivate() {
    if (!activate) return;
    activate.classList.add('hidden');
  }

  try {
    console.time("⏱️ runStartup total time");

    status('Starting camera…');
    const COUNTDOWN_MS = 15000; // tempo del countdown in ms (15 secondi)

    // 📷 CAMERA
    console.time("📷 startCamera()");
    const camPromise = startCamera().then(() => {
        console.timeEnd("📷 startCamera()");
    });

    console.time("⏱️ startCountdown()");
    const cdPromise = startCountdown(COUNTDOWN_MS).then(() => {
        console.timeEnd("⏱️ startCountdown()");
    });

    console.time("📍 getUserPosition()");
    const geoPromise = getUserPosition(COUNTDOWN_MS).then(() => {
        console.timeEnd("📍 getUserPosition()");
    });

    const modelPromise = (async () => {
      try {
        // ⏱️ TEMPO TOTALE MODELLI
        console.time("🧠 AI models: TOTAL");

        // Detector
        console.time("🔍 initDetector()");
        await initDetector();
        console.timeEnd("🔍 initDetector()");

        // Embedding model
        console.time("📐 initEmbeddingModel()");
        await initEmbeddingModel();
        console.timeEnd("📐 initEmbeddingModel()");

        // Monument DB
        console.time("📦 loadMonumentDB()");
        await loadMonumentDB();
        console.timeEnd("📦 loadMonumentDB()");

        console.log("Modelli caricati durante il countdown");

        // 🔚 TEMPO TOTALE MODELLI
        console.timeEnd("🧠 AI models: TOTAL");

      } catch (e) {
        console.error("Errore caricamento modelli:", e);
      }
    })();

    // aspetta che finiscano contemporaneamente camera, countdown, posizione e modelli
    await Promise.all([camPromise, cdPromise, geoPromise, modelPromise]);
    console.timeEnd("⏱️ runStartup total time");
    console.log("🔥 Tutte le promesse risolte: camera, countdown, GPS e modelli pronti!");
    hideActivate();

    if (hudEl) hudEl.classList.add('hidden');
    running = true;
    startLoop();

    // salva la posizione se buona
    if (userCoords) {
      console.log("✅ Posizione utente valida:", userCoords);
    } else {
      console.warn("⚠️ Posizione non precisa o non disponibile");
    }
  } catch (err) {
    console.error(err);
    if (startBtn) startBtn.disabled = false;
    // Keep activate card visible and show error if present
    try {
      const title = document.getElementById('activateTitle');
      const t = getI18n(getLang());
      if (title) title.textContent = t.activation?.permNeeded || 'Camera permission needed';
      if (cnt) cnt.textContent = '!';
      if (bar) bar.style.width = '0%';
    } catch {}
    status('Error: ' + (err?.message || err));
  }
}

if (startBtn) {
  startBtn.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation(); } catch {}; runStartup(); });
}

// Auto-start the camera only when scanner elements are present
(function(){
  if (!videoEl) return; // Not on scanner page
  function kick(){ try{ runStartup(); } catch(e){} }
  if (document.readyState==='complete' || document.readyState==='interactive') setTimeout(kick, 200);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(kick, 200); }, { once: true });
})();

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API non disponibile. Usa un browser moderno su HTTPS o localhost.');
  }
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    throw new Error('La videocamera richiede HTTPS (oppure localhost). Apri la pagina con https:// o avvia un server locale.');
  }

  try { videoEl.setAttribute('playsinline', ''); } catch {}
  try { videoEl.setAttribute('webkit-playsinline', ''); } catch {}
  try { videoEl.setAttribute('muted', ''); } catch {}
  videoEl.playsInline = true;
  videoEl.muted = true;
  videoEl.autoplay = true;

  const constraintAttempts = [
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false }
  ];

  let lastError = null;
  for (const constraints of constraintAttempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!stream) {
    const msg = lastError?.name === 'NotAllowedError'
      ? 'Accesso alla camera negato. Vai nelle impostazioni del browser e consenti l\'uso della fotocamera per questo sito.'
      : `Impossibile avviare la camera: ${lastError?.message || lastError || 'sconosciuto'}`;
    throw new Error(msg);
  }

  try { videoEl.srcObject = null; } catch {}
  videoEl.srcObject = stream;

  let played = false;
  try {
    await videoEl.play();
    played = true;
  } catch (e) {}
  if (!played) {
    await new Promise((res) => {
      const onMeta = async () => {
        videoEl.removeEventListener('loadedmetadata', onMeta);
        try { await videoEl.play(); } catch {}
        res();
      };
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) return onMeta();
      videoEl.addEventListener('loadedmetadata', onMeta);
    });
  }

  resizeCanvasToVideo();
  window.addEventListener('resize', resizeCanvasToVideo);
  window.addEventListener('orientationchange', resizeCanvasToVideo);
}

function resizeCanvasToVideo() {
  const vw = videoEl.videoWidth || 1280;
  const vh = videoEl.videoHeight || 720;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvasEl.width = Math.max(1, Math.floor(vw * dpr));
  canvasEl.height = Math.max(1, Math.floor(vh * dpr));
  const ctx = canvasEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

function startLoop() {
  const ctx = canvasEl.getContext('2d');
  const loop = async () => {
    if (!running) return;
    const now = performance.now();
    const t = videoEl.currentTime;
    if (detector && videoEl.readyState >= 2 && (t !== lastVideoTime) && (now - lastInferTime >= INFER_INTERVAL_MS)) {
      lastVideoTime = t;
      lastInferTime = now;
      const result = detector.detectForVideo(videoEl, now);
      await drawDetections(ctx, result, (entry, confidence) => openDetail(entry, confidence));
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

window.addEventListener('pagehide', stopAll, { once: true });
window.addEventListener('beforeunload', stopAll, { once: true });

function stopAll() {
  running = false;
  try { closeDetector(); } catch {}
  if (stream) {
    for (const track of stream.getTracks?.() || []) track.stop();
    stream = null;
  }

  // 👉 Ferma anche il tracciamento GPS
  stopUserTracking();
}

// Tip: For local development, serve over HTTPS (or localhost) for camera permissions.

// Homepage overlay and navigation setup (runs only if elements exist)
(function(){
  const scanBtn = document.getElementById('scanBtn');
  const overlay = document.getElementById('scannerOverlay');
  const frame = document.getElementById('scannerFrame');
  const closeBtn = document.getElementById('closeScanner');
  const curatorBtn = document.getElementById('curatorBtn');

  if (curatorBtn) {
    curatorBtn.addEventListener('click', () => { location.href = './manager_access.html'; });
  }

  if (!scanBtn || !overlay || !frame || !closeBtn) return; // Not on homepage

    function openScanner(){
        // In produzione meglio HTTPS; in locale localhost va bene
        if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            alert('La fotocamera richiede HTTPS (oppure localhost). Apri la pagina con https://');
            return;
        }
        location.href = 'scanner.html';
    }

  function closeScanner(){
    overlay.classList.remove('on');
    overlay.setAttribute('aria-hidden', 'true');
    try { frame.src = 'about:blank'; } catch {}
  }

  scanBtn.addEventListener('click', openScanner);
  closeBtn.addEventListener('click', closeScanner);
  window.addEventListener('pagehide', closeScanner, { once: true });
  window.addEventListener('beforeunload', closeScanner, { once: true });

  // Listen for close requests from the scanner iframe (Back button)
  window.addEventListener('message', (e)=>{
    const data = e?.data;
    if (data && (data.type === 'close-scanner')) {
      closeScanner();
    }
  });
})();
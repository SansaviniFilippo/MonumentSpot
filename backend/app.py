from fastapi import FastAPI, HTTPException, Header, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Dict, Any, Tuple
import os
import json
import tempfile
import threading
import numpy as np

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------

# Allow CORS origins (comma-separated). Default to local dev origins.
DEFAULT_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
FRONTEND_ORIGINS = [o.strip() for o in os.getenv("FRONTEND_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",") if o.strip()]

# Supabase integration imports and admin token
from .db import run
from .service import upsert_artwork_with_descriptors
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")

# ----------------------------------------------------------------------------
# App
# ----------------------------------------------------------------------------
app = FastAPI(title="ArtLens Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static images are served by the frontend only; backend no longer mounts /images

# ----------------------------------------------------------------------------
# In-memory cache (populated from Supabase)
# ----------------------------------------------------------------------------
artworks: Dict[str, Dict[str, Any]] = {}
flat_descriptors: List[Dict[str, Any]] = []
db_dim: Optional[int] = None

# Disk cache configuration
ENABLE_DISK_CACHE = os.getenv("ENABLE_DISK_CACHE", "true").strip().lower() in ("1", "true", "yes", "y", "on")
DISK_CACHE_PATH = os.getenv("DISK_CACHE_PATH") or os.path.join(tempfile.gettempdir(), "artlens_cache.json")
_cache_io_lock = threading.Lock()


def _l2_normalize(vec: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(vec)
    return vec / n if n > 0 else vec



# ----------------------------------------------------------------------------
# Schemas
# ----------------------------------------------------------------------------
class VisualDescriptor(BaseModel):
    id: Optional[str] = None
    image_path: Optional[str] = None

class CatalogItem(BaseModel):
    id: str
    title: Optional[str] = None
    artist: Optional[str] = None
    year: Optional[str] = None
    museum: Optional[str] = None
    location: Optional[str] = None
    descriptions: Optional[Dict[str, str]] = None
    visual_descriptors: Optional[List[VisualDescriptor]] = None
    model_config = ConfigDict(extra='allow')

class MatchRequest(BaseModel):
    embedding: List[float] = Field(..., description="Normalized embedding vector")
    top_k: int = Field(1, ge=1, le=50)
    threshold: float = Field(0.0, ge=-1.0, le=1.0)
    lang: Optional[str] = Field(default=None, description='Preferred language for description (it, en, ...)')

class MatchItem(BaseModel):
    artwork_id: str
    descriptor_id: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    description: Optional[str] = None
    confidence: float
    image_path: Optional[str] = None

class MatchResponse(BaseModel):
    matches: List[MatchItem]



# ----------------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "count": len(flat_descriptors),
        "dim": db_dim,
        "backend_db": "supabase",
    }


# Option B: separate catalog (metadata) and descriptors (embeddings)
# Note: using the CatalogItem schema defined above (with 'descriptions').


@app.get("/catalog", response_model=List[CatalogItem])
def get_catalog(with_image_counts: bool = False):
    # Serve from in-memory cache populated at startup
    items: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}
    if with_image_counts:
        for d in flat_descriptors:
            aid = d.get("artwork_id")
            if aid is not None:
                counts[aid] = counts.get(aid, 0) + 1
    for art_id, art in artworks.items():
        entry = {
            "id": art_id,
            "title": art.get("title"),
            "artist": art.get("artist"),
            "year": art.get("year"),
            "museum": art.get("museum"),
            "location": art.get("location"),
            "descriptions": art.get("descriptions"),
        }
        if with_image_counts:
            entry["image_count"] = counts.get(art_id, 0)
        items.append(entry)
    # Sort by title, nulls/empties last
    def _sort_key(x: Dict[str, Any]):
        t = x.get("title")
        empty = (t is None) or (isinstance(t, str) and t.strip() == "")
        return (empty, str(t).lower() if t is not None else "")
    items.sort(key=_sort_key)
    return items


@app.get("/descriptors", response_model=Dict[str, List[float]])
def get_descriptors():
    # Serve distinct first embedding per artwork from in-memory cache
    out: Dict[str, List[float]] = {}
    for d in flat_descriptors:
        aid = d.get("artwork_id")
        if aid is None or aid in out:
            continue
        emb = d.get("embedding")
        if isinstance(emb, list):
            out[str(aid)] = emb
    return out

# New v2 endpoints
@app.get("/descriptors_v2", response_model=Dict[str, List[List[float]]])
def get_descriptors_v2():
    # Serve all embeddings per artwork from in-memory cache
    out: Dict[str, List[List[float]]] = {}
    for d in flat_descriptors:
        aid = d.get("artwork_id")
        emb = d.get("embedding")
        if aid is None or not isinstance(emb, list):
            continue
        out.setdefault(str(aid), []).append(emb)
    return out

@app.get("/descriptors_meta_v2")
def get_descriptors_meta_v2():
    return [
        {
            "artwork_id": d["artwork_id"],
            "descriptor_id": d.get("descriptor_id"),
            "image_path": d.get("image_path"),
            "embedding": d.get("embedding"),
        }
        for d in flat_descriptors
    ]




@app.post("/match", response_model=MatchResponse)
def match(req: MatchRequest):
    global db_dim
    if not flat_descriptors:
        raise HTTPException(status_code=503, detail="Empty database")
    q = np.asarray(req.embedding, dtype=np.float32)
    if q.ndim != 1:
        q = q.reshape(-1)
    if db_dim is None:
        # infer from first descriptor
        for d in flat_descriptors:
            if isinstance(d.get("embedding"), list):
                db_dim = len(d["embedding"])
                break
    if db_dim is None:
        raise HTTPException(status_code=503, detail="Database embeddings dimension unknown")
    if int(q.shape[0]) != int(db_dim):
        raise HTTPException(status_code=400, detail=f"Embedding dim mismatch: got {q.shape[0]}, expected {db_dim}")
    q = _l2_normalize(q)

    # score per descriptor, keep best per artwork
    best_per_artwork: Dict[str, Dict[str, Any]] = {}
    for d in flat_descriptors:
        v = np.asarray(d["embedding"], dtype=np.float32)
        s = float(np.dot(q, v))
        if s < req.threshold:
            continue
        art_id = d["artwork_id"]
        cur = best_per_artwork.get(art_id)
        if cur is None or s > cur["score"]:
            best_per_artwork[art_id] = {"score": s, "descriptor": d}

    ranked = sorted(best_per_artwork.items(), key=lambda x: x[1]["score"], reverse=True)[: req.top_k]

    lang = (req.lang or '').lower()[:2] if req.lang else None
    results: List[MatchItem] = []
    for art_id, info in ranked:
        art = artworks.get(art_id, {})
        desc_text = None
        desc_map = art.get("descriptions") if isinstance(art.get("descriptions"), dict) else None
        if desc_map:
            if lang and desc_map.get(lang):
                desc_text = desc_map.get(lang)
            else:
                desc_text = desc_map.get('it') or desc_map.get('en') or next(iter(desc_map.values()), None)
        d = info["descriptor"]
        results.append(MatchItem(
            artwork_id=art_id,
            descriptor_id=d.get("descriptor_id"),
            title=art.get("title"),
            artist=art.get("artist"),
            description=desc_text,
            confidence=float(info["score"]),
            image_path=d.get("image_path"),
        ))

    return MatchResponse(matches=results)


# ----------------------------------------------------------------------------
# How to run (local dev):
#   pip install -r backend/requirements.txt
#   uvicorn backend.app:app --reload --host 0.0.0.0 --port 8000
# Optionally set:
#   export FRONTEND_ORIGINS=http://localhost:5173
# ----------------------------------------------------------------------------



# -----------------------------
# Supabase admin + health DB
# -----------------------------
class ArtworkUpsert(BaseModel):
    id: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    year: Optional[str] = None
    museum: Optional[str] = None
    location: Optional[str] = None
    descriptions: Optional[Dict[str, str]] = None
    visual_descriptors: Optional[List[Dict[str, Any]]] = None
    model_config = ConfigDict(extra='allow')


import re, unicodedata

def _slugify(text: str) -> str:
    if not text:
        return "opera"
    s = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    s = s.strip('-')
    return s or "opera"


def _ensure_unique_art_id(base_id: str) -> str:
    candidate = base_id or "opera"
    suffix = 2
    while True:
        db_taken = False
        try:
            row = run("select 1 from artworks where id = :id limit 1", {"id": candidate}).fetchone()
            db_taken = bool(row)
        except Exception:
            # DB not reachable; fall back to in-memory uniqueness only
            db_taken = False
        mem_taken = candidate in artworks
        if not (db_taken or mem_taken):
            return candidate
        candidate = f"{base_id}-{suffix}" if base_id else f"opera-{suffix}"
        suffix += 1


@app.post("/artworks")
def upsert_artwork(art: ArtworkUpsert, x_admin_token: str = Header(default="")):
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        art_dict = art.model_dump()
        art_id = (art_dict.get("id") or "").strip() if isinstance(art_dict.get("id"), str) else None
        if not art_id:
            base = _slugify(art_dict.get("title") or "")
            art_id = _ensure_unique_art_id(base)
            art_dict["id"] = art_id

        try:
            # Try DB upsert first
            upsert_res = upsert_artwork_with_descriptors(art_dict)
            # Refresh in-memory cache from Supabase so /match reflects the latest data
            try:
                _refresh_cache_from_db()
            except Exception as re:
                # Fallback: apply to in-memory cache and persist warm cache to disk
                print("[ArtLens] cache refresh error after upsert, applying fallback:", re)
                try:
                    _apply_upsert_to_cache(art_dict, upsert_res or {})
                    _save_cache_to_file()
                except Exception as e2:
                    print("[ArtLens] fallback cache apply failed:", e2)
        except ValueError as e:
            # Validation error coming from service (e.g., dim mismatch)
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            # DB write failed; fallback to in-memory cache persistence
            print("[ArtLens] DB upsert failed, saving to in-memory cache:", e)
            vds = art_dict.get("visual_descriptors") or []
            normalized = []
            observed_dim = None
            for idx, vd in enumerate(vds):
                emb = vd.get("embedding")
                if isinstance(emb, list):
                    vec = np.asarray(emb, dtype=np.float32)
                    vec = _l2_normalize(vec)
                    norm_list = vec.astype(float).tolist()
                    if observed_dim is None:
                        observed_dim = len(norm_list)
                    elif len(norm_list) != observed_dim:
                        raise HTTPException(status_code=400, detail=f"Descriptor {idx} dim mismatch")
                    normalized.append({
                        "descriptor_id": vd.get("id") or f"main#{idx}",
                        "embedding": norm_list,
                    })
            global db_dim
            if observed_dim is not None:
                if db_dim is None:
                    db_dim = observed_dim
                elif observed_dim != db_dim:
                    raise HTTPException(status_code=400, detail=f"Embedding dim mismatch: got {observed_dim}, expected {db_dim}")
            upsert_res = {"id": art_id, "descriptors": normalized, "observed_dim": observed_dim}
            try:
                _apply_upsert_to_cache(art_dict, upsert_res)
                _save_cache_to_file()
            except Exception as e2:
                print("[ArtLens] in-memory cache fallback failed:", e2)
                raise HTTPException(status_code=500, detail="Failed to persist in memory")
    except HTTPException:
        # Re-raise HTTP errors untouched
        raise
    except Exception as e:
        print("[ArtLens] upsert error:", e)
        raise HTTPException(status_code=500, detail="Failed to persist")
    return {"status": "ok", "id": art_id}


@app.delete("/artworks/{art_id}")
def delete_artwork(art_id: str, x_admin_token: str = Header(default="")):
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")
    # Delete the artwork; descriptors have ON DELETE CASCADE
    res = run("delete from artworks where id = :id", {"id": art_id})
    # rowcount is available on cursor result proxy; consider 0 as not found
    try:
        count = getattr(res, "rowcount", None)
    except Exception:
        count = None
    if count == 0:
        raise HTTPException(status_code=404, detail="Artwork not found")
    try:
        _refresh_cache_from_db()
    except Exception as re:
        print("[ArtLens] cache refresh error after delete:", re)
    return {"status": "ok", "deleted": art_id}


@app.get("/artworks/{art_id}")
def get_artwork_detail(art_id: str):
    # Serve artwork details from in-memory cache
    art = artworks.get(art_id)
    if not art:
        raise HTTPException(status_code=404, detail="Artwork not found")

    data = {
        "id": art_id,
        "title": art.get("title"),
        "artist": art.get("artist"),
        "year": art.get("year"),
        "museum": art.get("museum"),
        "location": art.get("location"),
        "descriptions": art.get("descriptions"),
    }

    # Build descriptors list from cached flat_descriptors
    descs = []
    for d in flat_descriptors:
        if d.get("artwork_id") == art_id:
            desc_id = d.get("descriptor_id")
            if desc_id is None:
                continue
            descs.append({
                "descriptor_id": desc_id,
                "image_path": d.get("image_path"),  # may be None in current cache
            })
    # Sort by descriptor_id for stable ordering
    descs.sort(key=lambda x: str(x.get("descriptor_id")))
    data["descriptors"] = descs
    return data


@app.delete("/artworks/{art_id}/descriptors/{descriptor_id}")
def delete_artwork_descriptor(art_id: str, descriptor_id: str, x_admin_token: str = Header(default="")):
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")
    res = run(
        "delete from descriptors where artwork_id = :art_id and descriptor_id = :desc_id",
        {"art_id": art_id, "desc_id": descriptor_id}
    )
    try:
        count = getattr(res, "rowcount", None)
    except Exception:
        count = None
    if count == 0:
        raise HTTPException(status_code=404, detail="Descriptor not found")
    try:
        _refresh_cache_from_db()
    except Exception as re:
        print("[ArtLens] cache refresh error after descriptor delete:", re)
    return {"status": "ok", "deleted": descriptor_id}


@app.get("/health_db")
def health_db():
    try:
        row = run("select count(*) from artworks").fetchone()
        cnt = int(row[0]) if row else 0
        return {"db": "supabase", "artworks": cnt}
    except Exception as e:
        e_orig = getattr(e, "orig", None)
        raw_msg = str(e_orig) if e_orig else str(e)
        # Trim to avoid leaking long SQLAlchemy help URLs
        return {"db": "supabase", "error": raw_msg[:200]}


# -----------------------------
# Cache refresh from Supabase for /match
# -----------------------------
from typing import Tuple as _TupleAlias  # local alias to avoid shadowing


def _apply_upsert_to_cache(art_meta: Dict[str, Any], upsert: Dict[str, Any]) -> None:
    """Best-effort: merge the just-upserted data into the in-memory cache.
    - Updates artworks[art_id] metadata fields.
    - Appends/updates descriptors in flat_descriptors for matching descriptor_id.
    - Sets db_dim if it was None and observed_dim is present.
    """
    try:
        global artworks, flat_descriptors, db_dim
        art_id = (art_meta.get("id") or "").strip()
        if not art_id:
            return
        # Update metadata for artwork
        cur = artworks.get(art_id) or {}
        cur.update({
            "title": art_meta.get("title"),
            "artist": art_meta.get("artist"),
            "year": art_meta.get("year"),
            "museum": art_meta.get("museum"),
            "location": art_meta.get("location"),
            "descriptions": art_meta.get("descriptions"),
        })
        artworks[art_id] = cur

        # Merge descriptors (avoid duplicates by descriptor_id)
        new_descs = upsert.get("descriptors") or []
        if new_descs:
            incoming_ids = {str(d.get("descriptor_id")) for d in new_descs if d.get("descriptor_id") is not None}
            # Remove old entries with same (artwork_id, descriptor_id) to avoid duplicates
            if incoming_ids:
                flat_descriptors = [d for d in flat_descriptors if not (d.get("artwork_id") == art_id and str(d.get("descriptor_id")) in incoming_ids)]
            # Append new entries
            for d in new_descs:
                desc_id = d.get("descriptor_id")
                emb = d.get("embedding")
                if desc_id is None or not isinstance(emb, list):
                    continue
                flat_descriptors.append({
                    "artwork_id": art_id,
                    "descriptor_id": str(desc_id),
                    "embedding": emb,
                    # image_path unknown here; leave absent/None
                })
        # Set db_dim if not set
        if db_dim is None:
            od = upsert.get("observed_dim")
            if isinstance(od, int):
                db_dim = od
    except Exception as e:
        print("[ArtLens] Warning: failed to apply upsert to cache:", e)


def _save_cache_to_file():
    if not ENABLE_DISK_CACHE:
        return
    try:
        payload = {
            "version": 1,
            "db_dim": db_dim,
            "artworks": artworks,
            "flat_descriptors": flat_descriptors,
        }
        # Atomic write
        tmp_path = DISK_CACHE_PATH + ".tmp"
        with _cache_io_lock:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp_path, DISK_CACHE_PATH)
        size = os.path.getsize(DISK_CACHE_PATH)
        print(f"[ArtLens] Cache saved to disk: {DISK_CACHE_PATH} ({size} bytes)")
    except Exception as e:
        print("[ArtLens] Failed to save cache to disk:", e)


def _load_cache_from_file() -> bool:
    if not ENABLE_DISK_CACHE:
        return False
    try:
        if not os.path.exists(DISK_CACHE_PATH):
            return False
        with _cache_io_lock:
            with open(DISK_CACHE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        if not isinstance(data, dict):
            return False
        req_keys = ("artworks", "flat_descriptors")
        if not all(k in data for k in req_keys):
            return False
        # Basic sanity checks
        aw = data.get("artworks")
        fd = data.get("flat_descriptors")
        dim = data.get("db_dim")
        if not isinstance(aw, dict) or not isinstance(fd, list):
            return False
        # Assign globals
        global artworks, flat_descriptors, db_dim
        artworks = {str(k): v for k, v in aw.items()}
        flat_descriptors = fd
        db_dim = dim if isinstance(dim, int) or dim is None else None
        print(f"[ArtLens] Cache loaded from disk: artworks={len(artworks)}, descriptors={len(flat_descriptors)}, dim={db_dim}")
        return True
    except Exception as e:
        print("[ArtLens] Failed to load cache from disk:", e)
        return False


def _refresh_cache_from_db() -> _TupleAlias[int, int]:
    """Reload artworks and flat_descriptors from Supabase.
    Returns (num_artworks, num_descriptors).
    """
    global artworks, flat_descriptors, db_dim

    # Load artworks metadata
    rows_art = run(
        """
        select id, title, artist, year, museum, location, descriptions
        from artworks
        """
    ).mappings().all()
    new_artworks = {str(r["id"]): dict(r) for r in rows_art}

    # Load descriptors
    rows_desc = run(
        "select artwork_id, descriptor_id, embedding from descriptors order by artwork_id, descriptor_id"
    ).all()

    new_flat = []
    dim = None
    for art_id, desc_id, emb in rows_desc:
        # emb is a PG float8[] mapped as Python list/tuple via psycopg/SQLAlchemy
        vec = list(emb) if emb is not None else None
        if not isinstance(vec, list):
            continue
        if dim is None:
            dim = len(vec)
        elif len(vec) != dim:
            # Skip inconsistent dimensions
            continue
        new_flat.append({
            "artwork_id": str(art_id),
            "descriptor_id": str(desc_id),
            "embedding": vec,
        })

    artworks = new_artworks
    flat_descriptors = new_flat
    db_dim = dim
    # Persist warm cache to disk (best-effort)
    try:
        _save_cache_to_file()
    except Exception as e:
        print("[ArtLens] Warning: could not persist cache to disk:", e)
    return (len(artworks), len(flat_descriptors))


# Refresh cache on startup so /match is ready without legacy JSON
@app.on_event("startup")
def _startup_refresh_cache():
    # Try disk cache first for warm startup
    try:
        if _load_cache_from_file():
            return
    except Exception as e:
        print("[ArtLens] Disk cache load failed, will try DB:", e)

    # Retry startup cache load to tolerate transient DB connectivity on Render/Supabase
    max_retries = int(os.getenv("STARTUP_DB_RETRIES", "5"))
    delay = float(os.getenv("STARTUP_DB_INITIAL_DELAY", "1.5"))
    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            a, d = _refresh_cache_from_db()
            print(f"[ArtLens] Cache loaded from Supabase: artworks={a}, descriptors={d}, dim={db_dim}")
            return
        except Exception as e:
            last_err = e
            if attempt < max_retries:
                print(f"[ArtLens] Startup cache load attempt {attempt}/{max_retries} failed: {e}. Retrying in {delay:.1f}s...")
                import time
                time.sleep(delay)
                delay = min(delay * 2, 15.0)
            else:
                print(f"[ArtLens] Failed to load cache from Supabase at startup after {max_retries} attempts: {e}")
                break



# -----------------------------
# Remote performance logging (Option B)
# -----------------------------
from typing import Dict as _DictAlias, Any as _AnyAlias

@app.post("/log_perf")
def log_perf(payload: _DictAlias[str, _AnyAlias] = Body(...)):
    """Receive frontend perf batches and print summary to server logs.
    Expected payload: { meta:{...}, data:{ t:[], crop:[], embed:[], match:[], dbSize:[], dim:[] }, sessionId, seq, reason }
    """
    try:
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")
        meta = payload.get("meta", {})
        data = payload.get("data", {})
        sess = payload.get("sessionId")
        seq = payload.get("seq")
        def _mean(arr):
            try:
                return float(sum(arr) / len(arr)) if isinstance(arr, list) and arr else 0.0
            except Exception:
                return 0.0
        n = len(data.get("t", [])) if isinstance(data.get("t", []), list) else 0
        mc = _mean(data.get("crop", []))
        me = _mean(data.get("embed", []))
        mm = _mean(data.get("match", []))
        cfg = meta.get("config") if isinstance(meta, dict) else None
        tfb = meta.get("tfBackend") if isinstance(meta, dict) else None
        print(f"[PerfLog] session={sess} seq={seq} samples={n} mean(ms) crop={mc:.2f} embed={me:.2f} match={mm:.2f} backend={tfb} conf={cfg}")
        return {"status": "ok", "accepted": int(n)}
    except Exception as e:
        print("[PerfLog] error processing payload:", e)
        raise HTTPException(status_code=400, detail="invalid payload")

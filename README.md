# ArtLens

ArtLens è un sistema di riconoscimento opere d’arte composto da:
- un frontend web che usa la fotocamera del dispositivo, rileva il quadro nella scena (MediaPipe ObjectDetector), produce un embedding visivo (TensorFlow.js + MobileNet) e fa il matching lato client;
- un backend FastAPI che espone il catalogo e i descrittori, oltre a endpoint amministrativi per inserire/aggiornare opere e descrittori nel database (Postgres/Supabase).

Questo README spiega come avviare il progetto in locale, come usarlo e come funziona la pipeline.


## Contenuti
- Panoramica e architettura
- Requisiti
- Setup e avvio
  - Backend (FastAPI)
  - Frontend (static server)
- Utilizzo
  - Utente (Scanner)
  - Curatore (Dashboard)
- API del backend
- Schema DB atteso (SQL di esempio)
- Come funziona (dettagli tecnici)
- Configurazione
- Troubleshooting


## Panoramica e architettura
- Frontend (frontend/public):
  - index.html: landing con pulsanti “Scan Artwork” e “Curator Login”.
  - scanner.html: pagina con video camera, overlay e UI dettagli. Carica:
    - MediaPipe Tasks Vision (ObjectDetector) per rilevamento oggetti da modello TFLite locale (public/models/last_model.tflite);
    - TensorFlow.js + MobileNet per generare embedding 224×224 L2-normalizzati;
    - codice JS (src/js) per matching locale contro gli embedding scaricati dal backend.
  - curator_access.html / curator_dashboard.html: accesso demo e dashboard per inserire opere. La dashboard calcola gli embedding lato client e li invia al backend.
- Backend (backend/):
  - FastAPI con endpoint pubblici per catalogo e descrittori e endpoint admin per upsert/cancellazione.
  - Connessione a Postgres (Supabase) via SQLAlchemy.
  - Cache in memoria dei dati per risposte rapide; opzionale persistenza su disco.


## Requisiti
- Python 3.10+ (consigliato 3.11)
- Node.js non necessario; basta un server statico semplice (anche Python http.server) per servire il frontend
- Un database Postgres raggiungibile (es. Supabase) e la sua connection string
- Browser moderno con supporto WebGL (per TFJS) e permesso fotocamera


## Setup e avvio

### 1) Backend (FastAPI)
1. Creare ed attivare un virtualenv e installare i requisiti:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
   pip install -r backend/requirements.txt
   ```
2. Impostare le variabili d’ambiente minime:
   - SUPABASE_DB_URL: stringa connessione Postgres (usare driver psycopg v3). Esempi:
     - postgres://USER:PASS@HOST:PORT/DB?sslmode=require
     - postgresql://USER:PASS@HOST:PORT/DB?sslmode=require
   - ADMIN_TOKEN: token segreto richiesto dagli endpoint admin (es. generare con un UUID)
   - FRONTEND_ORIGINS (opzionale): origini CORS consentite (default: localhost 5173/8080/3000)
   - ENABLE_DISK_CACHE (opzionale, default true) e DISK_CACHE_PATH (opzionale)

   Esempio (macOS/Linux):
   ```bash
   export SUPABASE_DB_URL="postgres://USER:PASS@HOST:6543/postgres?sslmode=require"
   export ADMIN_TOKEN="inserisci-un-token-segreto"
   export FRONTEND_ORIGINS="http://localhost:8080"
   ```
3. Avviare FastAPI con Uvicorn:
   ```bash
   uvicorn backend.app:app --reload --host 0.0.0.0 --port 8000
   ```
   Verifica: http://localhost:8000/health


### 2) Frontend (static server)
Il frontend deve essere servito da un server HTTP (la fotocamera non funziona su file:// e richiede HTTPS su domini pubblici; in locale localhost è consentito).

1. Portarsi nella cartella frontend/public ed avviare un server statico, ad esempio:
   ```bash
   # Opzione Python
   cd frontend/public
   python -m http.server 8080
   # oppure (Node, se lo usi): npx serve -l 8080
   ```
2. Aprire il browser su: http://localhost:8080/
3. Per puntare il frontend al backend locale, assicurarsi che in scanner.html e curator_dashboard.html ci sia:
   ```html
   <script>window.BACKEND_URL='http://localhost:8000';</script>
   ```
   In alternativa, constants.js ha un fallback a http://localhost:8000.

Nota: su dispositivi mobili la fotocamera richiede HTTPS; per demo locale usare il desktop o configurare un reverse proxy HTTPS.


## Utilizzo

### Utente (Scanner)
- Dalla home (index.html) clicca “Scan Artwork” (apre scanner.html):
  - Concedi il permesso della fotocamera.
  - Il riquadro verde appare quando il modello rileva un’opera.
  - Il sistema calcola un embedding con MobileNet e fa matching con il DB locale (scaricato dal backend). Mostra titolo, artista, descrizione e confidenza.
  - Localizzazione IT/EN disponibile dalla barra linguaggio.

### Curatore (Dashboard)
- Accesso demo: curator_access.html (credenziali demo salvate in localStorage: email curator@museum.com, password tesi2025). È solo per scopi dimostrativi.
- Dashboard: curator_dashboard.html
  1. Carica una o più immagini dell’opera.
  2. Inserisci metadati (titolo, artista, anno, museo, location) e descrizioni (IT/EN).
  3. Al salvataggio, il browser calcola gli embedding (224×224, L2) e invia un JSON a POST /artworks con header X-Admin-Token (ti verrà chiesto al primo salvataggio e verrà ricordato in localStorage).
  4. Il backend salva metadati + descrittori nel DB e aggiorna la cache; il frontend ricarica il DB.
  5. Se serve, usa la tab “Manage Collection” per consultare e gestire la collezione (richiede le API attive; include azioni come fetch dettagli /artworks/{id} e delete).


## API del backend (principali)
- GET /health: stato backend, numero descrittori e dimensione embedding.
- GET /health_db: verifica connessione a DB (conteggio opere o errore sintetico).
- GET /catalog[?with_image_counts=true]: lista opere (id, title, artist, year, museum, location, descriptions).
- GET /descriptors: mappa { artwork_id: embedding[] } (un solo descrittore per opera).
- GET /descriptors_v2: mappa { artwork_id: [ [..emb1..], [..emb2..] ] } (tutti i descrittori per opera).
- GET /descriptors_meta_v2: lista con artwork_id, descriptor_id, image_path, embedding.
- POST /match: { embedding: float[], top_k, threshold, lang } -> matches[] (non usato dal frontend di default, che fa matching locale, ma utile per client esterni).
- POST /log_perf: endpoint per telemetria prestazioni (attivabile con ?telemetry=1 nel frontend).

Endpoint admin (richiedono header X-Admin-Token uguale a ADMIN_TOKEN):
- POST /artworks: upsert opera e descrittori. Accetta payload come:
  ```json
  {
    "title": "Ritratto di soggetto",
    "artist": "Nome Artista",
    "year": "1620 ca.",
    "museum": "Museo Esempio",
    "location": "Room 2",
    "descriptions": { "it": "Descrizione in italiano", "en": "Description in English" },
    "visual_descriptors": [
      { "id": "img-1", "embedding": [0.01, 0.02, 0.03] },
      { "id": "img-2", "embedding": [0.04, 0.05, 0.06] }
    ]
  }
  ```
- GET /artworks/{id}: dettaglio opera (inclusa lista dei descriptor_id).
- DELETE /artworks/{id}: rimuove l’opera (cascade sui descrittori).
- DELETE /artworks/{id}/descriptors/{descriptor_id}: rimuove un singolo descrittore.


## Schema DB atteso (SQL di esempio)
Il backend si aspetta tre tabelle: settings, artworks, descriptors. Esempio compatibile con Postgres/Supabase:
```sql
create table if not exists settings (
  key text primary key,
  value jsonb
);

create table if not exists artworks (
  id text primary key,
  title text,
  artist text,
  year text,
  museum text,
  location text,
  descriptions jsonb,
  updated_at timestamptz default now()
);

create table if not exists descriptors (
  artwork_id text references artworks(id) on delete cascade,
  descriptor_id text,
  embedding double precision[],
  primary key (artwork_id, descriptor_id)
);
```
Note:
- Alla prima upsert, il backend salva in settings.key='db_dim' la dimensione embedding osservata; successivi inserimenti devono avere la stessa dimensione.
- Gli embedding sono L2-normalizzati (cosine = dot product).


## Come funziona (pipeline)
1. Rilevamento: MediaPipe ObjectDetector (modello TFLite in public/models/last_model.tflite) individua il riquadro dell’opera.
2. Preprocessing: il riquadro viene ritagliato e ridimensionato a 224×224.
3. Embedding: TensorFlow.js MobileNet (versione 2, alpha 1.0) genera un vettore di caratteristiche; il vettore viene L2-normalizzato.
4. Matching: lato client si scarica il DB di embedding dal backend (/descriptors_v2 + /catalog). Si calcola la similitudine come prodotto scalare (coseno). Soglia e limiti dal file src/js/constants.js (es. COSINE_THRESHOLD).
5. UI: viene mostrato titolo, artista, descrizione (in IT/EN in base alla lingua) e la confidenza. Facoltativamente si registra telemetria verso /log_perf.


## Configurazione
- Variabili d’ambiente backend:
  - SUPABASE_DB_URL (obbligatoria)
  - ADMIN_TOKEN (obbligatoria per admin)
  - FRONTEND_ORIGINS (opzionale, CSV)
  - ENABLE_DISK_CACHE=true|false (default true)
  - DISK_CACHE_PATH (opzionale)
- Frontend:
  - Imposta window.BACKEND_URL in scanner.html/curator_dashboard.html per specificare l’URL backend (default http://localhost:8000).
  - Modello TFLite: public/models/last_model.tflite. Puoi aggiornarlo sostituendo il file; assicurati coerenza con il tipo di oggetti da rilevare.
  - Parametri: vedi src/js/constants.js (COSINE_THRESHOLD, MIN_BOX_SCORE, CROP_SIZE, ecc.).


## Troubleshooting
- La fotocamera non parte:
  - Usa un server HTTP (non file://). Su domini pubblici serve HTTPS; in locale localhost è ok.
  - Controlla permessi del browser e che non sia in un iFrame non consentito.
- CORS error dal frontend:
  - Aggiungi l’origine del tuo server statico in FRONTEND_ORIGINS e riavvia il backend.
- Nessun risultato/matching vuoto:
  - Il DB potrebbe essere vuoto: usa la dashboard del curatore per inserire opere.
  - Verifica che /catalog e /descriptors_v2 rispondano e che ci siano embedding.
- Mismatch dimensione embedding:
  - Assicurati che gli embedding nel DB siano generati con la stessa MobileNet/224 e normalizzazione. Se lo schema è stato popolato con un modello diverso, rigenera o svuota/ricrea i descrittori.
- Errore 401 sugli endpoint admin:
  - Verifica che l’header X-Admin-Token corrisponda a ADMIN_TOKEN.
- Connessione DB fallita:
  - Controlla SUPABASE_DB_URL (usa driver psycopg v3; sslmode=require in Supabase).


## Struttura del progetto (principale)
- backend/
  - app.py (API, cache, matching, admin)
  - service.py (upsert e normalizzazione, coerenza dimensioni)
  - db.py (connessione SQLAlchemy)
  - requirements.txt
- frontend/
  - public/ (pagine HTML, CSS, immagini, modelli .tflite)
  - src/js/ (logica scanner, embedding, matching, UI, dashboard)
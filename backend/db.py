import os
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from sqlalchemy import create_engine, text

# ----------------------------------------------------------------------------
# DB URL handling (support DATABASE_URL or SUPABASE_DB_URL)
# ----------------------------------------------------------------------------
raw_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL")
if not raw_url:
    raise RuntimeError("Missing DATABASE_URL or SUPABASE_DB_URL environment variable")

# Normalize to psycopg3 dialect and ensure sslmode=require
url = raw_url
if url.startswith("postgres://"):
    url = "postgresql+psycopg://" + url[len("postgres://"):]
elif url.startswith("postgresql://") and not url.startswith("postgresql+psycopg://"):
    url = "postgresql+psycopg://" + url[len("postgresql://"):]

# Append sslmode=require if missing
parts = urlsplit(url)
query_pairs = dict(parse_qsl(parts.query, keep_blank_values=True))
if "sslmode" not in {k.lower(): v for k, v in query_pairs.items()}:
    query_pairs["sslmode"] = "require"
new_query = urlencode(query_pairs)
DB_URL = urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))

# Keep pool small for free tiers / serverless; add pre_ping and recycle
engine = create_engine(
    DB_URL,
    pool_size=5,
    max_overflow=5,
    pool_pre_ping=True,
    pool_recycle=300,
    pool_timeout=30,
)


def run(sql: str, params=None):
    """Execute a SQL statement within a transaction and return the result cursor."""
    with engine.begin() as conn:
        return conn.execute(text(sql), params or {})


def get_db_url_diagnostics():
    """Return non-sensitive diagnostics about the configured DB URL (no user/pass)."""
    try:
        p = urlsplit(DB_URL)
        # Extract sslmode if present
        q = dict(parse_qsl(p.query, keep_blank_values=True))
        sslmode = q.get("sslmode")
        # Remove credentials from netloc for safety
        hostport = p.hostname
        if p.port:
            hostport = f"{hostport}:{p.port}"
        dbname = p.path.lstrip("/") or None
        return {
            "dialect": p.scheme,
            "host": p.hostname,
            "port": p.port,
            "database": dbname,
            "sslmode": sslmode,
            "has_psycopg3": p.scheme.startswith("postgresql+psycopg"),
        }
    except Exception as e:
        return {"error": str(e)}

import os
import time
from sqlalchemy import create_engine, text
from sqlalchemy.pool import QueuePool  # Cambiato da NullPool
from sqlalchemy.exc import OperationalError
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# SQLAlchemy engine for Supabase Postgres
raw_url = os.environ["SUPABASE_DB_URL"]

# Ensure SQLAlchemy uses psycopg v3 driver
if raw_url.startswith("postgres://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgres://"):]
elif raw_url.startswith("postgresql://") and not raw_url.startswith("postgresql+psycopg://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgresql://"):]
else:
    DB_URL = raw_url

# Configurazione ottimizzata per Session Pooler
engine = create_engine(
    DB_URL,
    poolclass=QueuePool,  # Usa QueuePool invece di NullPool per Session Pooler
    pool_size=5,          # Numero di connessioni nel pool
    max_overflow=10,      # Connessioni extra quando necessario
    pool_pre_ping=True,   # Verifica connessioni prima dell'uso
    pool_recycle=3600,    # Ricrea connessioni ogni ora
    echo=False,
    connect_args={
        "connect_timeout": 30,  # Timeout più lungo per Session Pooler
        "server_settings": {
            "application_name": "render_backend_session",
        }
    }
)

def run_with_retry(sql: str, params=None, max_retries=2, retry_delay=0.5):
    """Execute SQL with lighter retry logic for Session Pooler."""
    last_exception = None

    for attempt in range(max_retries):
        try:
            with engine.begin() as conn:
                return conn.execute(text(sql), params or {})
        except OperationalError as e:
            last_exception = e
            error_msg = str(e).lower()

            # Retry per errori di connessione meno aggressivo
            should_retry = any([
                "connection" in error_msg and "failed" in error_msg,
                "server closed" in error_msg,
                "timeout" in error_msg
            ])

            if should_retry and attempt < max_retries - 1:
                logger.warning(f"Connection issue on attempt {attempt + 1}/{max_retries}, retrying...")
                time.sleep(retry_delay)
                continue
            else:
                raise
        except Exception as e:
            logger.error(f"Database error: {str(e)[:200]}...")
            raise

    raise last_exception

def run(sql: str, params=None):
    """Execute a SQL statement within a transaction and return the result cursor."""
    return run_with_retry(sql, params)

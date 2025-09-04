import os
import time
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
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

# Configurazione ottimizzata per Transaction Pooler
engine = create_engine(
    DB_URL,
    poolclass=NullPool,  # Nessun pooling lato SQLAlchemy
    echo=False,
    # Configurazioni specifiche per psycopg3 e Transaction Pooler
    connect_args={
        "connect_timeout": 10,  # Timeout connessione più breve
        "prepare_threshold": None
    }
)

def run_with_retry(sql: str, params=None, max_retries=3, retry_delay=1):
    """Execute SQL with retry logic for connection issues."""
    last_exception = None

    for attempt in range(max_retries):
        try:
            with engine.begin() as conn:
                return conn.execute(text(sql), params or {})
        except OperationalError as e:
            last_exception = e
            error_msg = str(e).lower()

            # Retry solo per errori di connessione specifici
            should_retry = any([
                "server closed the connection unexpectedly" in error_msg,
                "connection failed" in error_msg,
                "connection timeout expired" in error_msg,
                "connection to server" in error_msg and "failed" in error_msg
            ])

            if should_retry and attempt < max_retries - 1:
                logger.warning(f"Connection failed on attempt {attempt + 1}/{max_retries}: {str(e)[:200]}...")
                logger.warning(f"Retrying in {retry_delay}s...")
                time.sleep(retry_delay)
                retry_delay *= 2  # Exponential backoff
                continue
            else:
                # Se non è un errore di connessione, non fare retry
                logger.error(f"Database error (no retry): {str(e)[:200]}...")
                raise
        except Exception as e:
            # Per altri tipi di errori, non fare retry
            logger.error(f"Unexpected database error: {str(e)[:200]}...")
            raise

    # Se arriviamo qui, tutti i retry sono falliti
    logger.error(f"All {max_retries} connection attempts failed. Last error: {str(last_exception)[:200]}...")
    raise last_exception

def run(sql: str, params=None):
    """Execute a SQL statement with automatic retry on connection failures."""
    return run_with_retry(sql, params)

def run_simple(sql: str, params=None, max_retries=2):
    """Execute simple SQL with fewer retries for faster operations."""
    return run_with_retry(sql, params, max_retries=max_retries, retry_delay=0.5)
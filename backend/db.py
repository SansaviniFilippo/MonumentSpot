# db.py
import os
from typing import Any, Dict, List, Optional, Union

from sqlalchemy import create_engine, text

# ------------------------------------------------------------
# Engine setup (Supabase Postgres) - richiede SUPABASE_DB_URL nell'env
# ------------------------------------------------------------
raw_url = os.environ["SUPABASE_DB_URL"]

# Ensure SQLAlchemy uses psycopg v3 driver (not psycopg2)
if raw_url.startswith("postgres://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgres://"):]
elif raw_url.startswith("postgresql://") and not raw_url.startswith("postgresql+psycopg://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgresql://"):]
else:
    DB_URL = raw_url  # already correct or custom

# Keep pool small for free tiers
engine = create_engine(DB_URL, pool_size=5, max_overflow=5, pool_pre_ping=True)


def run(sql: str, params: Optional[Union[Dict[str, Any], List[Dict[str, Any]]]] = None, prepare: bool = True):
    """Execute a SQL statement within a transaction and return the SQLAlchemy Result.

    - params can be a single dict (executed once) or a list of dicts (executemany).
    - prepare=False disables server-side prepared statements for this statement.
    """
    stmt = text(sql)
    if not prepare:
        stmt = stmt.execution_options(postgresql_prepare=False)

    with engine.begin() as conn:
        if isinstance(params, list):
            return conn.execute(stmt, params)
        else:
            return conn.execute(stmt, params or {})

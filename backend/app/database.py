import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "sql_app.db")

raw_database_url = os.environ.get("DATABASE_URL", f"sqlite:///{DB_PATH}")


def normalize_database_url(url: str) -> str:
    """Normalize Postgres URLs to use the psycopg v3 driver if not explicitly specified."""
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


SQLALCHEMY_DATABASE_URL = normalize_database_url(raw_database_url)

# Connection Pool Sizing Arithmetic:
# (FastAPI Workers * (pool_size + max_overflow)) + (Celery Processes * (pool_size + max_overflow)) <= max_connections - buffer
# Example with default max_connections=100 (15 reserved for admin/superusers):
# (1 FastAPI * (5 + 10)) + (4 Celery * (5 + 10)) = 15 + 60 = 75 <= 85 available connections.
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        pool_size=int(os.environ.get("DB_POOL_SIZE", "5")),
        max_overflow=int(os.environ.get("DB_MAX_OVERFLOW", "10")),
        pool_pre_ping=True,
        pool_recycle=int(os.environ.get("DB_POOL_RECYCLE", "1800")),
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """FastAPI database session dependency."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database tables."""
    Base.metadata.create_all(bind=engine)


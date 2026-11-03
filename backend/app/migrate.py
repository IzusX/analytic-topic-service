"""Explicit schema v2 migration. Never runs as an import or startup side effect.

SQLite legacy databases require a new backup file. PostgreSQL legacy databases
require an independently created backup and --backup-confirmed.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sqlite3

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from .database import Base, engine
from .models import channel as _models  # register tables, without opening a connection
from .adapters.youtube import _duration_seconds

SCHEMA_VERSION = 2
CORE_TABLES = {"channels", "videos", "snapshots"}
ADDITIONS = {
    "channels": ("subscriber_count_hidden",),
    "videos": ("duration_seconds", "channel_subscriber_count_hidden", "fetched_at", "source_payload"),
}


def _missing_sqlite_file(bind: Engine) -> bool:
    database = bind.url.database
    return bind.dialect.name == "sqlite" and database not in (None, "", ":memory:") and not Path(database).exists()


def schema_status(bind: Engine) -> dict:
    if _missing_sqlite_file(bind):
        return {"version": 0, "current": False, "tables": [], "row_counts": {}}
    tables = set(inspect(bind).get_table_names())
    with bind.connect() as connection:
        version = connection.execute(text("SELECT max(version) FROM schema_migrations")).scalar() if "schema_migrations" in tables else 0
        counts = {name: connection.execute(text(f"SELECT count(*) FROM {name}")).scalar() for name in sorted(CORE_TABLES & tables)}
    return {"version": version or 0, "current": version == SCHEMA_VERSION, "tables": sorted(tables), "row_counts": counts}


def _assert_model_tables(inspector) -> None:
    tables = set(inspector.get_table_names())
    for table in Base.metadata.sorted_tables:
        if table.name not in tables:
            raise RuntimeError("Database schema is incomplete; no migration changes should be committed.")
        actual = {column["name"] for column in inspector.get_columns(table.name)}
        if not set(table.columns.keys()) <= actual:
            raise RuntimeError("Database columns do not match schema v2; no migration changes should be committed.")
    if "is_shorts" in {column["name"] for column in inspector.get_columns("videos")}:
        raise RuntimeError("Legacy video classification remains; check the explicit migration.")


def assert_schema_current(bind: Engine) -> None:
    status = schema_status(bind)
    if not status["current"]:
        raise RuntimeError("Database schema is not current. Run: python -m app.migrate (legacy DB requires a backup).")
    _assert_model_tables(inspect(bind))


def _sqlite_backup(bind: Engine, backup_path: Path) -> None:
    database = bind.url.database
    if not database or database == ":memory:":
        raise RuntimeError("Existing in-memory SQLite migration requires explicit backup confirmation.")
    source_path = Path(database).resolve()
    if backup_path.resolve() == source_path:
        raise ValueError("Backup must not overwrite the source database.")
    # Exclusive creation prevents silently replacing a previous backup.
    with backup_path.open("xb"):
        pass
    with sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True) as source:
        with sqlite3.connect(backup_path) as target:
            source.backup(target)


def migrate(bind: Engine, backup_path: Path | None = None, backup_confirmed: bool = False) -> dict:
    status = schema_status(bind)
    if status["version"] > SCHEMA_VERSION:
        raise RuntimeError("Database schema is newer than this application; migration refused.")
    if status["current"]:
        assert_schema_current(bind)
        return {"status": "up_to_date", "version": SCHEMA_VERSION}
    existing = CORE_TABLES & set(status["tables"])
    if existing and existing != CORE_TABLES:
        raise RuntimeError("Incomplete legacy database: inspect it before migration; no tables were changed.")
    if existing:
        inspector = inspect(bind)
        for name in CORE_TABLES:
            required = set(Base.metadata.tables[name].columns.keys()) - set(ADDITIONS.get(name, ()))
            actual = {column["name"] for column in inspector.get_columns(name)}
            if not required <= actual:
                raise RuntimeError(f"Unexpected legacy columns in {name}; inspect the schema before migration. No tables were changed.")
        if bind.dialect.name == "sqlite" and bind.url.database != ":memory:":
            if backup_path is None:
                raise RuntimeError("Legacy SQLite database requires --backup PATH to a new backup file.")
            _sqlite_backup(bind, backup_path)
        elif not backup_confirmed:
            raise RuntimeError("Back up the existing database first, then use --backup-confirmed.")
    if bind.dialect.name not in {"sqlite", "postgresql"}:
        raise RuntimeError("This migration supports SQLite and PostgreSQL only.")

    with bind.begin() as connection:
        if bind.dialect.name == "sqlite":
            # Explicit BEGIN makes SQLite DDL and backfill atomic even in legacy driver mode.
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        if existing:
            if bind.dialect.name == "sqlite":
                version = tuple(map(int, connection.execute(text("SELECT sqlite_version()" )).scalar().split('.')))
                if version < (3, 35, 0):
                    raise RuntimeError("SQLite >=3.35 is required for the non-recreating DROP COLUMN migration.")
            inspector = inspect(connection)
            for name, additions in ADDITIONS.items():
                columns = {item["name"] for item in inspector.get_columns(name)}
                for column_name in additions:
                    if column_name not in columns:
                        column = Base.metadata.tables[name].columns[column_name]
                        type_sql = column.type.compile(dialect=bind.dialect)
                        connection.execute(text(f"ALTER TABLE {name} ADD COLUMN {column_name} {type_sql}"))
            video_columns = {item["name"] for item in inspect(connection).get_columns("videos")}
            if "is_shorts" in video_columns:
                connection.execute(text("ALTER TABLE videos DROP COLUMN is_shorts"))
            for row in connection.execute(text("SELECT id, duration FROM videos WHERE duration_seconds IS NULL")):
                connection.execute(text("UPDATE videos SET duration_seconds=:seconds WHERE id=:id"), {
                    "id": row.id, "seconds": _duration_seconds(row.duration),
                })
        Base.metadata.create_all(bind=connection)
        # Validate before the version stamp/commit, so an unexpected schema cannot be half-migrated.
        _assert_model_tables(inspect(connection))
        connection.execute(text("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)"))
        connection.execute(text("INSERT INTO schema_migrations (version) VALUES (:version)"), {"version": SCHEMA_VERSION})
    assert_schema_current(bind)
    return {"status": "migrated" if existing else "initialized", "version": SCHEMA_VERSION}


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize or explicitly migrate schema v2; no API calls.")
    parser.add_argument("--check", action="store_true", help="Read schema status and row counts without modifying it")
    parser.add_argument("--backup", type=Path, help="New SQLite backup file; existing file is never overwritten")
    parser.add_argument("--backup-confirmed", action="store_true", help="Confirm an independently created backup for PostgreSQL/in-memory tests")
    args = parser.parse_args()
    try:
        result = schema_status(engine) if args.check else migrate(engine, args.backup, args.backup_confirmed)
    except (RuntimeError, ValueError, FileExistsError) as exc:
        parser.exit(1, str(exc) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

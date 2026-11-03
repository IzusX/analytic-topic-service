from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Boolean, Column, ForeignKey, Index, MetaData, Table, create_engine, inspect, text

from app.database import Base
from app.main import app
from app.migrate import ADDITIONS, assert_schema_current, migrate, schema_status
import app.main as main_module
import app.migrate as migration_module


def legacy_database(path: Path, missing_column: str | None = None, numeric_seconds: bool = False):
    bind = create_engine(f"sqlite:///{path}")
    metadata = MetaData()
    for name in ("channels", "videos", "snapshots"):
        columns = []
        for column in Base.metadata.tables[name].columns:
            if column.name in ADDITIONS.get(name, ()) and not (numeric_seconds and column.name == "duration_seconds"):
                continue
            if name == "channels" and column.name == missing_column:
                continue
            foreign_keys = [ForeignKey(fk.target_fullname, ondelete=fk.ondelete) for fk in column.foreign_keys]
            columns.append(Column(column.name, column.type, *foreign_keys, primary_key=column.primary_key, nullable=column.nullable, index=column.index))
        if name == "videos":
            columns.append(Column("is_shorts", Boolean, nullable=False, server_default="0"))
        Table(name, metadata, *columns)
    Index("ix_videos_channel_published", metadata.tables["videos"].c.channel_id, metadata.tables["videos"].c.published_at)
    metadata.create_all(bind)
    with bind.begin() as connection:
        connection.execute(text("INSERT INTO channels (id,title,description,updated_at,subscriber_count) VALUES ('channel','Сохранённый канал','описание','2024-01-01 00:00:00',1234)"))
        connection.execute(text("INSERT INTO videos (id,channel_id,title,duration,is_shorts,view_count) VALUES ('video','channel','Сохранённое видео','PT3M1S',0,5678)"))
        connection.execute(text("INSERT INTO snapshots (channel_id,date,subscriber_count,view_count) VALUES ('channel','2024-01-01 00:00:00',1234,10000)"))
    return bind


def test_fresh_schema_is_initialized_and_idempotent(tmp_path):
    bind = create_engine(f"sqlite:///{tmp_path / 'new.db'}")
    assert schema_status(bind)["version"] == 0
    assert not (tmp_path / "new.db").exists()
    assert migrate(bind)["status"] == "initialized"
    assert_schema_current(bind)
    assert migrate(bind)["status"] == "up_to_date"
    assert schema_status(bind)["row_counts"] == {"channels": 0, "snapshots": 0, "videos": 0}
    bind.dispose()


def test_legacy_migration_requires_backup_and_preserves_rows_indexes_and_values(tmp_path):
    original = tmp_path / "original.db"
    bind = legacy_database(original)
    with pytest.raises(RuntimeError, match="requires --backup"):
        migrate(bind)
    assert "is_shorts" in {column["name"] for column in inspect(bind).get_columns("videos")}
    backup = tmp_path / "backup.db"
    result = migrate(bind, backup)
    assert result["status"] == "migrated"
    assert_schema_current(bind)
    assert schema_status(bind)["row_counts"] == {"channels": 1, "snapshots": 1, "videos": 1}
    with bind.connect() as connection:
        row = connection.execute(text("SELECT id,title,view_count,duration,duration_seconds,source_payload,fetched_at FROM videos")).one()
        assert row.id == "video" and row.title == "Сохранённое видео" and row.view_count == 5678
        assert row.duration == "PT3M1S" and row.duration_seconds == 181
        assert row.source_payload is None and row.fetched_at is None
        assert connection.execute(text("SELECT subscriber_count FROM channels")).scalar() == 1234
    assert "is_shorts" not in {column["name"] for column in inspect(bind).get_columns("videos")}
    assert "ix_videos_channel_published" in {index["name"] for index in inspect(bind).get_indexes("videos")}
    with sqlite3.connect(backup) as connection:
        assert connection.execute("SELECT is_shorts,view_count FROM videos").fetchone() == (0, 5678)
        assert connection.execute("SELECT count(*) FROM snapshots").fetchone()[0] == 1
    assert migrate(bind)["status"] == "up_to_date"
    bind.dispose()


def test_existing_backup_never_overwritten(tmp_path):
    bind = legacy_database(tmp_path / "original.db")
    backup = tmp_path / "backup.db"
    backup.write_bytes(b"keep existing backup")
    with pytest.raises(FileExistsError):
        migrate(bind, backup)
    assert backup.read_bytes() == b"keep existing backup"
    assert schema_status(bind)["version"] == 0
    bind.dispose()


def test_source_database_cannot_be_backup_destination(tmp_path):
    path = tmp_path / "original.db"
    bind = legacy_database(path)
    with pytest.raises(ValueError, match="must not overwrite"):
        migrate(bind, path)
    assert schema_status(bind)["version"] == 0
    bind.dispose()


def test_unexpected_core_schema_rejected_before_any_change(tmp_path):
    bind = legacy_database(tmp_path / "partial.db", missing_column="country")
    before = [{**column, "type": str(column["type"])} for column in inspect(bind).get_columns("videos")]
    with pytest.raises(RuntimeError, match="Unexpected legacy columns"):
        migrate(bind, tmp_path / "backup.db")
    after = [{**column, "type": str(column["type"])} for column in inspect(bind).get_columns("videos")]
    assert after == before
    assert schema_status(bind)["version"] == 0
    bind.dispose()


def test_malformed_existing_cache_table_rolls_back_before_version_stamp(tmp_path):
    bind = legacy_database(tmp_path / "partial-cache.db")
    with bind.begin() as connection:
        connection.execute(text("CREATE TABLE channel_analyses (channel_id VARCHAR(64) PRIMARY KEY)"))
    with pytest.raises(RuntimeError, match="columns do not match"):
        migrate(bind, tmp_path / "backup.db")
    assert schema_status(bind)["version"] == 0
    columns = {column["name"] for column in inspect(bind).get_columns("videos")}
    assert "is_shorts" in columns
    assert "duration_seconds" not in columns
    assert schema_status(bind)["row_counts"] == {"channels": 1, "snapshots": 1, "videos": 1}
    bind.dispose()


def test_mid_migration_failure_rolls_back_ddl_and_backfill(tmp_path, monkeypatch):
    bind = legacy_database(tmp_path / "original.db")
    def fail(_duration):
        raise RuntimeError("injected backfill failure")
    monkeypatch.setattr(migration_module, "_duration_seconds", fail)
    with pytest.raises(RuntimeError, match="injected"):
        migrate(bind, tmp_path / "backup.db")
    columns = {column["name"] for column in inspect(bind).get_columns("videos")}
    assert "is_shorts" in columns and "duration_seconds" not in columns
    assert schema_status(bind)["version"] == 0
    with bind.connect() as connection:
        assert connection.execute(text("SELECT duration FROM videos")).scalar() == "PT3M1S"
    bind.dispose()


def test_known_numeric_duration_not_overwritten_by_missing_iso(tmp_path):
    bind = legacy_database(tmp_path / "partial.db", numeric_seconds=True)
    with bind.begin() as connection:
        connection.execute(text("UPDATE videos SET duration=NULL, duration_seconds=240"))
        connection.execute(text("INSERT INTO videos (id,channel_id,title,duration,duration_seconds,is_shorts) VALUES ('bad-iso','channel','known seconds','garbage',600,0)"))
        connection.execute(text("INSERT INTO videos (id,channel_id,title,duration,is_shorts) VALUES ('unknown','channel','unknown duration','invalid',0)"))
    migrate(bind, tmp_path / "backup.db")
    with bind.connect() as connection:
        assert dict(connection.execute(text("SELECT id,duration_seconds FROM videos")).all()) == {"video": 240, "bad-iso": 600, "unknown": None}
    bind.dispose()


def test_import_and_read_only_check_do_not_create_database(tmp_path):
    database_path = tmp_path / "not-created.db"
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{database_path}", "YOUTUBE_API_KEY": ""}
    code = "import socket; socket.socket.connect=lambda *args: (_ for _ in ()).throw(AssertionError('network disabled')); import app.main"
    backend_dir = Path(__file__).resolve().parents[1]
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, cwd=backend_dir)
    assert result.returncode == 0, result.stderr
    assert not database_path.exists()
    result = subprocess.run([sys.executable, "-m", "app.migrate", "--check"], capture_output=True, text=True, env=env, cwd=backend_dir)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["version"] == 0
    assert not database_path.exists()


def test_startup_refuses_legacy_without_migrating_it(tmp_path, monkeypatch):
    bind = legacy_database(tmp_path / "original.db")
    monkeypatch.setattr(main_module, "engine", bind)
    with pytest.raises(RuntimeError, match="schema is not current"):
        with TestClient(app):
            pass
    assert schema_status(bind)["version"] == 0
    assert "is_shorts" in {column["name"] for column in inspect(bind).get_columns("videos")}
    bind.dispose()

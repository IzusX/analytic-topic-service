from __future__ import annotations
from datetime import datetime, timezone
import socket

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.adapters.base import AdapterChannel, AdapterVideo, AdapterVideoPage, DataSourceAdapter
from app.database import get_db
from app.main import app
from app.migrate import migrate
from app.services.source import get_adapter_factory
import app.main as main_module


@pytest.fixture(autouse=True)
def block_external_network(monkeypatch):
    """Every test must use fake source calls; accidental quota/network calls fail immediately."""
    def denied(*_args, **_kwargs):
        raise AssertionError("External network is disabled in backend tests")
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket, "create_connection", denied)


def make_video(video_id: str, seconds: int | None = 181, views: int | None = 100, channel_id: str = "channel", date: datetime | None = None, subscribers: int | None = 1000) -> AdapterVideo:
    return AdapterVideo(
        id=video_id, title=f"Видео {video_id}", published_at=date,
        duration=f"PT{seconds}S" if seconds is not None else None,
        duration_seconds=seconds, view_count=views, channel_id=channel_id,
        channel_title="Тестовый канал", channel_subscriber_count=subscribers,
    )


def make_channel(channel_id: str = "channel", playlist: str | None = "uploads", subscribers: int | None = 1000) -> AdapterChannel:
    return AdapterChannel(
        id=channel_id, title="Тестовый канал", description="", published_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
        country=None, subscriber_count=subscribers, view_count=10000, video_count=20,
        uploads_playlist_id=playlist,
    )


class FakeAdapter(DataSourceAdapter):
    def __init__(self):
        super().__init__()
        self.channel = make_channel()
        self.video = make_video("video")
        self.search_page = AdapterVideoPage(videos=[self.video], items_scanned=1, channels=[self.channel])
        self.upload_pages = {None: AdapterVideoPage(videos=[self.video], items_scanned=1)}
        self.calls = []
        self.search_error = self.channel_error = self.video_error = None

    def search_channels(self, query: str, limit: int = 20):
        return [self.channel] if self.channel else []

    def get_channel(self, channel_id: str):
        self.calls.append(("channel", channel_id))
        self.quota_used_estimate += 1
        if self.channel_error:
            raise self.channel_error
        return self.channel

    def search_videos(self, **kwargs):
        self.calls.append(("search", kwargs))
        self.quota_used_estimate += 102
        if self.search_error:
            raise self.search_error
        return self.search_page

    def get_uploads_page(self, playlist_id: str, page_token=None, limit: int = 50):
        self.calls.append(("uploads", page_token, limit))
        self.quota_used_estimate += 2
        page = self.upload_pages[page_token]
        if isinstance(page, Exception):
            raise page
        return page

    def get_videos(self, channel_id: str, limit: int = 50):
        raise AssertionError("Analytical sampling must not use get_videos or a search cache")

    def get_video(self, video_id: str):
        self.calls.append(("video", video_id))
        self.quota_used_estimate += 2
        if self.video_error:
            raise self.video_error
        return self.video


@pytest.fixture
def adapter():
    return FakeAdapter()


@pytest.fixture
def database():
    bind = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    @event.listens_for(bind, "connect")
    def fk(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")
    migrate(bind)
    Session = sessionmaker(bind=bind, expire_on_commit=False)
    with Session() as session:
        yield session, bind
    bind.dispose()


@pytest.fixture
def client(database, adapter, monkeypatch):
    session, bind = database
    monkeypatch.setattr(main_module, "engine", bind)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_adapter_factory] = lambda: (lambda: adapter)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()

from datetime import datetime, timezone
import json

import httplib2
from googleapiclient.errors import HttpError
from sqlalchemy import event, select

from app.adapters.base import AdapterVideoPage
from app.models.channel import Channel, Video
from app.services.sync import upsert_channel, upsert_video
from conftest import make_video, make_channel
import app.routers.search as search_module


def test_search_optional_query_stores_page_once_without_refetch(client, adapter, database):
    session, _ = database
    commits = []
    event.listen(session, "after_commit", lambda _session: commits.append(True))
    response = client.post("/api/search/videos", json={"query": "  ", "relevance_language": "ru"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["query"] == ""
    assert result["quota_used_estimate"] == 102
    assert result["items_scanned"] == result["matched_count"] == 1
    assert result["videos"][0]["duration_seconds"] == 181
    assert "is_shorts" not in result["videos"][0]
    assert len(adapter.calls) == 1 and adapter.calls[0][0] == "search"
    assert adapter.calls[0][1]["query"] == ""
    assert "region_code" not in adapter.calls[0][1]
    assert session.get(Video, "video") is not None
    assert session.get(Channel, "channel").subscriber_count == 1000
    assert len(commits) == 1


def test_empty_filtered_page_preserves_continuation_and_actual_cost(client, adapter):
    adapter.search_page.next_page_token = "next"
    adapter.search_page.items_scanned = 50
    response = client.post("/api/search/videos", json={"min_subscribers": 10000})
    assert response.status_code == 200
    result = response.json()
    assert result["videos"] == []
    assert result["next_page_token"] == "next"
    assert result["items_scanned"] == 50
    assert result["matched_count"] == 0
    assert result["quota_used_estimate"] == 102
    assert len(adapter.calls) == 1


def test_search_deduplicates_preserving_first_positions(client, adapter):
    a, b, c = [make_video(name) for name in "abc"]
    adapter.search_page = AdapterVideoPage(videos=[a, b, a, c], items_scanned=4)
    response = client.post("/api/search/videos", json={})
    assert response.status_code == 200, response.text
    assert [video["id"] for video in response.json()["videos"]] == ["a", "b", "c"]


def test_subscriber_unknown_does_not_overwrite_known_db_value(client, adapter, database):
    session, _ = database
    upsert_channel(session, make_channel(subscribers=1234))
    session.commit()
    adapter.channel.subscriber_count = None
    adapter.video.channel_subscriber_count = None
    response = client.post("/api/search/videos", json={})
    assert response.status_code == 200
    assert response.json()["videos"][0]["channel_subscriber_count"] is None
    assert response.json()["videos"][0]["view_sub_ratio"] is None
    assert session.get(Channel, "channel").subscriber_count == 1234


def test_video_snapshot_does_not_relabel_preserved_old_counts(client, adapter, database):
    session, _ = database
    old = make_video("video", subscribers=1234)
    upsert_video(session, old)
    session.commit()
    adapter.video.channel_subscriber_count = None
    adapter.search_page.channels = []
    client.post("/api/search/videos", json={})
    stored = session.get(Video, "video")
    assert stored.channel_subscriber_count == 1234
    assert stored.source_payload["channel_subscriber_count"] is None
    # A short direct video response avoids starting an unrelated sample in this assertion.
    stored.source_payload = {**stored.source_payload, "duration_seconds": 180}
    session.commit()
    response = client.get("/api/videos/video")
    assert response.status_code == 200
    assert response.json()["channel_subscriber_count"] is None
    assert response.json()["view_sub_ratio"] is None


def test_explicit_hidden_subscriber_status_clears_old_count(client, adapter, database):
    session, _ = database
    upsert_channel(session, make_channel(subscribers=1234))
    session.commit()
    adapter.channel.subscriber_count = None
    adapter.channel.subscriber_count_hidden = True
    adapter.video.channel_subscriber_count = None
    adapter.video.channel_subscriber_count_hidden = True
    result = client.post("/api/search/videos", json={}).json()
    assert result["videos"][0]["channel_subscriber_count_hidden"] is True
    assert session.get(Channel, "channel").subscriber_count is None


def test_api_freezes_month_and_keeps_pagination_date(client, adapter, monkeypatch):
    now = datetime(2024, 3, 31, 12, tzinfo=timezone.utc)
    monkeypatch.setattr(search_module, "utc_now", lambda: now)
    result = client.post("/api/search/videos", json={"period": "month"}).json()
    assert result["applied"]["published_after"] == "2024-02-29T12:00:00Z"
    monkeypatch.setattr(search_module, "utc_now", lambda: datetime(2024, 4, 2, 12, tzinfo=timezone.utc))
    following = {**result["applied"], "page_token": "next"}
    response = client.post("/api/search/videos", json=following)
    assert response.status_code == 200
    assert response.json()["applied"]["published_after"] == result["applied"]["published_after"]


def test_invalid_input_does_not_create_source_call_or_echo_secret(client, adapter):
    response = client.post("/api/search/videos", json={"min_subscribers": -1, "api_key": "PRIVATE_EXAMPLE_TOKEN"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_request"
    assert "PRIVATE_EXAMPLE_TOKEN" not in response.text
    assert adapter.calls == []


def test_computed_date_error_is_validated_before_source_creation(client, adapter, monkeypatch):
    monkeypatch.setattr(search_module, "utc_now", lambda: datetime(2024, 3, 31, tzinfo=timezone.utc))
    response = client.post("/api/search/videos", json={"period": "day", "published_before": "2024-03-01T00:00:00Z"})
    assert response.status_code == 422
    assert adapter.calls == []


def test_source_quota_error_never_echoes_key_url_or_raw_error(client, adapter, database):
    content = {"error": {"message": "secret PRIVATE_EXAMPLE_TOKEN", "errors": [{"reason": "quotaExceeded"}]}}
    adapter.search_error = HttpError(httplib2.Response({"status": "403"}), json.dumps(content).encode(), uri="https://example.invalid/?key=PRIVATE_EXAMPLE_TOKEN")
    response = client.post("/api/search/videos", json={})
    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "quota_exceeded"
    assert "PRIVATE_EXAMPLE_TOKEN" not in response.text
    session, _ = database
    assert session.scalars(select(Video)).all() == []


def test_no_key_header_mode_or_automatic_requests_in_health(client, adapter):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["schema_version"] == 2
    assert adapter.calls == []

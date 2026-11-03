from datetime import datetime, timezone
import copy
import json

import httplib2
from googleapiclient.errors import HttpError
from sqlalchemy import select

from app.adapters.base import AdapterVideoPage
from app.models.channel import Channel, ChannelAnalysis, Video
from app.services.analysis import SAMPLE_CACHE_KEY
from app.services.source import get_adapter_factory
from app.services.sync import upsert_video
from app.main import app
from conftest import make_video


def test_sample_scans_past_short_first_page_and_retains_unknown_views(client, adapter, database):
    first = [make_video(f"short-{i}", 180) for i in range(50)]
    selected = [make_video(f"long-{i}", 181, None if i == 0 else i) for i in range(30)]
    remaining = [make_video(f"short-tail-{i}", 60) for i in range(20)]
    adapter.upload_pages = {
        None: AdapterVideoPage(first, next_page_token="second", items_scanned=50),
        "second": AdapterVideoPage(selected + remaining, next_page_token="third", items_scanned=50),
    }
    response = client.get("/api/channels/channel")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["sample"]["selected_count"] == 30
    assert result["sample"]["metric_count"] == result["metrics"]["count"] == 29
    assert result["sample"]["uploads_scanned"] == 100
    assert result["sample"]["pages_scanned"] == 2
    assert result["sample"]["stop_reason"] == "sample_full"
    assert result["sample"]["excluded_duration_count"] == 70
    assert "long-0" in [video["id"] for video in result["videos"]]
    assert result["quota_used_estimate"] == 5
    assert len(adapter.calls) == 3
    session, _ = database
    assert len(session.scalars(select(Video)).all()) == 100
    assert session.get(Video, "short-tail-19").duration_seconds == 60


def test_sample_stops_at_four_pages_and_200_records(client, adapter):
    adapter.upload_pages = {
        None: AdapterVideoPage([make_video(f"a-{i}", 180) for i in range(50)], "p1", 50),
        "p1": AdapterVideoPage([make_video(f"b-{i}", None) for i in range(50)], "p2", 50),
        "p2": AdapterVideoPage([], "p3", 50),
        "p3": AdapterVideoPage([make_video(f"d-{i}", 60) for i in range(50)], "p4", 50),
    }
    result = client.get("/api/channels/channel").json()
    assert result["sample"]["selected_count"] == 0
    assert result["sample"]["pages_scanned"] == 4
    assert result["sample"]["uploads_scanned"] == 200
    assert result["sample"]["unknown_duration_count"] == 50
    assert result["sample"]["unavailable_video_count"] == 50
    assert result["sample"]["scan_limit_reached"] is True
    assert result["sample"]["stop_reason"] == "scan_limit"
    assert result["metrics"]["median_views"] is None
    assert result["videos"] == []
    assert result["quota_used_estimate"] == 9
    assert [call[1] for call in adapter.calls if call[0] == "uploads"] == [None, "p1", "p2", "p3"]


def test_four_empty_pages_with_tokens_stop_by_page_budget(client, adapter):
    adapter.upload_pages = {key: AdapterVideoPage([], next_page_token=f"p{i+1}", items_scanned=0) for i, key in enumerate([None, "p1", "p2", "p3"])}
    result = client.get("/api/channels/channel").json()
    assert result["sample"]["pages_scanned"] == 4
    assert result["sample"]["uploads_scanned"] == 0
    assert result["sample"]["stop_reason"] == "scan_limit"
    assert len(adapter.calls) == 5


def test_known_empty_exhausted_sample_is_cached_without_sufficiency_threshold(client, adapter):
    adapter.upload_pages = {None: AdapterVideoPage([], items_scanned=0)}
    result = client.get("/api/channels/channel").json()
    assert result["sample"]["stop_reason"] == "uploads_exhausted"
    assert result["sample"]["pages_scanned"] == 1
    assert result["metrics"]["count"] == 0
    assert result["metrics"]["consistency"] is None
    calls = len(adapter.calls)
    repeated = client.get("/api/channels/channel").json()
    assert repeated["from_cache"] is True
    assert repeated["quota_used_estimate"] == 0
    assert len(adapter.calls) == calls


def test_search_cache_is_not_an_analytical_sample(client, adapter, database):
    session, _ = database
    for i in range(35):
        upsert_video(session, make_video(f"search-{i}", views=1000000))
    session.commit()
    adapter.upload_pages = {None: AdapterVideoPage([make_video("actual", views=20)], items_scanned=1)}
    result = client.get("/api/channels/channel").json()
    assert result["metrics"]["count"] == 1
    assert result["metrics"]["median_views"] == 20
    assert [video["id"] for video in result["videos"]] == ["actual"]
    assert "повторяемость не определяется" in result["summary"]
    assert "verdict" not in result["metrics"]
    assert "min_median_views" not in result["metrics"]


def test_warm_channel_needs_no_factory_or_key(client, adapter):
    first = client.get("/api/channels/channel").json()
    def denied():
        raise AssertionError("Cache hit must not initialize an adapter")
    app.dependency_overrides[get_adapter_factory] = lambda: denied
    second = client.get("/api/channels/channel").json()
    assert second["from_cache"] is True
    assert second["fetched_at"] == first["fetched_at"]
    assert second["quota_used_estimate"] == 0


def test_refresh_failure_preserves_old_confirmed_analysis_and_rows(client, adapter, database):
    first = client.get("/api/channels/channel").json()
    session, _ = database
    stored_payload = copy.deepcopy(session.get(ChannelAnalysis, ("channel", SAMPLE_CACHE_KEY)).payload)
    adapter.channel.title = "Не должно сохраниться"
    adapter.upload_pages = {
        None: AdapterVideoPage([make_video("new", views=9999)], next_page_token="next", items_scanned=1),
        "next": RuntimeError("PRIVATE_EXAMPLE_TOKEN in source failure URL"),
    }
    response = client.get("/api/channels/channel?force_sync=true")
    assert response.status_code == 502
    assert "PRIVATE_EXAMPLE_TOKEN" not in response.text
    assert session.get(ChannelAnalysis, ("channel", SAMPLE_CACHE_KEY)).payload == stored_payload
    assert session.get(Video, "new") is None
    assert session.get(Channel, "channel").title == first["channel"]["title"]
    repeated = client.get("/api/channels/channel").json()
    assert repeated["fetched_at"] == first["fetched_at"]
    assert repeated["metrics"] == first["metrics"]


def test_missing_uploads_id_is_error_not_a_confirmed_empty_cache(client, adapter, database):
    original = client.get("/api/channels/channel").json()
    adapter.channel.uploads_playlist_id = None
    response = client.get("/api/channels/channel?force_sync=true")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "uploads_unavailable"
    repeated = client.get("/api/channels/channel").json()
    assert repeated["sample"]["selected_count"] == original["sample"]["selected_count"]
    assert repeated["from_cache"] is True


def test_old_unavailable_cache_is_not_accepted(client, adapter, database):
    client.get("/api/channels/channel")
    session, _ = database
    cache = session.get(ChannelAnalysis, ("channel", SAMPLE_CACHE_KEY))
    payload = copy.deepcopy(cache.payload)
    payload["sample"].update({"pages_scanned": 0, "selected_count": 0, "stop_reason": "uploads_unavailable"})
    cache.payload = payload
    session.commit()
    calls = len(adapter.calls)
    response = client.get("/api/channels/channel")
    assert response.status_code == 200
    assert response.json()["from_cache"] is False
    assert len(adapter.calls) == calls + 2


def test_dates_unknown_last_and_missing_views_do_not_remove_video(client, adapter):
    adapter.upload_pages = {None: AdapterVideoPage([
        make_video("unknown-date", views=None),
        make_video("new", views=0, date=datetime(2024, 2, 1, tzinfo=timezone.utc)),
        make_video("old", views=10, date=datetime(2024, 1, 1)),
    ], items_scanned=3)}
    result = client.get("/api/channels/channel").json()
    assert [video["id"] for video in result["videos"]] == ["old", "new", "unknown-date"]
    assert result["sample"]["selected_count"] == 3
    assert result["sample"]["metric_count"] == 2
    assert result["sample"]["unknown_date_count"] == 1
    assert result["sample"]["date_from"] == "2024-01-01T00:00:00Z"
    assert result["sample"]["date_to"] == "2024-02-01T00:00:00Z"


def test_zero_subscribers_not_replaced_by_an_old_fallback(client, adapter):
    adapter.channel.subscriber_count = 0
    result = client.get("/api/channels/channel").json()
    assert result["channel"]["subscriber_count"] == 0
    assert result["videos"][0]["channel_subscriber_count"] == 0
    assert result["videos"][0]["view_sub_ratio"] is None


def test_zero_median_and_missing_engagement_are_not_fake_values(client, adapter):
    adapter.video.view_count = 0
    result = client.get("/api/channels/channel").json()
    assert result["metrics"]["median_views"] == 0
    assert result["metrics"]["spike_ratio"] is None
    assert result["metrics"]["cv"] is None
    assert result["metrics"]["avg_like_view"] is None
    assert result["metrics"]["avg_comment_view"] is None
    assert result["videos"][0]["view_median_ratio"] is None


def test_source_context_is_not_cache_key_and_never_marks_replacement(client, adapter, database):
    session, _ = database
    upsert_video(session, make_video("short", 180))
    upsert_video(session, make_video("unknown", None))
    session.commit()
    first = client.get("/api/channels/channel?source_video_id=video").json()
    assert first["source_video"]["status"] == "included"
    assert first["source_video"]["view_median_ratio"] == 1
    calls = len(adapter.calls)
    second = client.get("/api/channels/channel?source_video_id=short").json()
    assert second["source_video"]["status"] == "duration_too_short"
    assert second["source_video"]["id"] == "short"
    assert second["source_video"]["view_median_ratio"] is None
    unknown = client.get("/api/channels/channel?source_video_id=unknown").json()
    assert unknown["source_video"]["status"] == "duration_unknown"
    outside = client.get("/api/channels/channel?source_video_id=outside").json()
    assert outside["source_video"]["status"] == "not_in_sample"
    assert len(adapter.calls) == calls


def test_updated_search_does_not_change_confirmed_snapshot_without_refresh(client, adapter):
    first = client.get("/api/channels/channel").json()
    adapter.search_page = AdapterVideoPage([make_video("video", views=1000)], items_scanned=1)
    client.post("/api/search/videos", json={})
    repeated = client.get("/api/channels/channel").json()
    assert repeated["videos"][0]["view_count"] == first["videos"][0]["view_count"] == 100
    assert repeated["fetched_at"] == first["fetched_at"]


def test_channel_not_found_and_quota_are_distinct(client, adapter):
    adapter.channel = None
    response = client.get("/api/channels/channel")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "channel_not_found"
    adapter.channel_error = HttpError(httplib2.Response({"status": "403"}), json.dumps({"error": {"errors": [{"reason": "quotaExceeded"}]}}).encode(), uri="https://example.invalid/?key=PRIVATE_EXAMPLE_TOKEN")
    response = client.get("/api/channels/channel")
    assert response.status_code == 429
    assert "PRIVATE_EXAMPLE_TOKEN" not in response.text

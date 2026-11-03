import copy

from sqlalchemy import select

from app.adapters.base import AdapterVideoPage
from app.main import app
from app.models.channel import ChannelAnalysis, Video
from app.services.analysis import SAMPLE_CACHE_KEY
from app.services.source import get_adapter_factory
from conftest import make_video


def test_short_video_never_starts_or_compares_to_long_sample(client, adapter):
    adapter.video = make_video("video", 180, 100, subscribers=10)
    adapter.video.like_count = 5
    adapter.video.comment_count = 2
    first = client.get("/api/videos/video")
    assert first.status_code == 200, first.text
    result = first.json()
    assert result["comparison_status"] == "duration_too_short"
    assert result["view_median_ratio"] is None
    assert result["sample"] is None
    assert result["view_sub_ratio"] == 10
    assert result["like_view_ratio"] == .05
    assert result["comment_view_ratio"] == .02
    assert "is_anomaly" not in result
    assert "is_shorts" not in result
    assert [call[0] for call in adapter.calls] == ["video"]
    second = client.get("/api/videos/video").json()
    assert second["from_cache"] is True
    assert second["quota_used_estimate"] == 0
    assert second["view_sub_ratio"] == result["view_sub_ratio"]
    assert second["like_view_ratio"] == result["like_view_ratio"]
    assert second["comment_view_ratio"] == result["comment_view_ratio"]
    assert len(adapter.calls) == 1


def test_unknown_duration_does_not_infer_format_or_start_sample(client, adapter):
    adapter.video = make_video("video", None)
    result = client.get("/api/videos/video").json()
    assert result["comparison_status"] == "duration_unknown"
    assert result["view_median_ratio"] is None
    assert result["channel_median_views"] is None
    assert [call[0] for call in adapter.calls] == ["video"]


def test_long_video_and_confirmed_sample_cached_without_repeat_requests(client, adapter):
    first = client.get("/api/videos/video")
    assert first.status_code == 200, first.text
    result = first.json()
    assert result["comparison_status"] == "included"
    assert result["view_median_ratio"] == 1
    assert result["channel_median_views"] == 100
    assert result["quota_used_estimate"] == 5
    assert result["sample_fetched_at"] == result["fetched_at"]
    calls = len(adapter.calls)
    repeated = client.get("/api/videos/video").json()
    assert repeated["from_cache"] is True
    assert repeated["quota_used_estimate"] == 0
    assert len(adapter.calls) == calls


def test_direct_card_preserves_sample_coherence_after_newer_search(client, adapter):
    original = client.get("/api/channels/channel").json()
    adapter.search_page = AdapterVideoPage([make_video("video", views=1000)], items_scanned=1)
    client.post("/api/search/videos", json={})
    response = client.get("/api/videos/video")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["view_count"] == original["videos"][0]["view_count"] == 100
    assert result["view_median_ratio"] == 1
    assert result["fetched_at"] == result["sample_fetched_at"] == original["fetched_at"]
    assert result["from_cache"] is True


def test_nonmember_video_is_not_replaced_or_compared(client, adapter):
    videos = [make_video(f"new-{i}", views=i + 1) for i in range(30)]
    adapter.upload_pages = {None: AdapterVideoPage(videos, next_page_token="more", items_scanned=30)}
    result = client.get("/api/videos/video").json()
    assert result["id"] == "video"
    assert result["comparison_status"] == "not_in_sample"
    assert result["view_median_ratio"] is None
    assert result["sample"]["selected_count"] == 30
    assert result["sample_fetched_at"] is not None


def test_video_refresh_source_failure_leaves_old_snapshot(client, adapter, database):
    adapter.video = make_video("video", 180)
    original = client.get("/api/videos/video").json()
    session, _ = database
    before = copy.deepcopy(session.get(Video, "video").source_payload)
    adapter.video_error = RuntimeError("https://source.invalid?key=PRIVATE_EXAMPLE_TOKEN")
    response = client.get("/api/videos/video?force_sync=true")
    assert response.status_code == 502
    assert "PRIVATE_EXAMPLE_TOKEN" not in response.text
    assert session.get(Video, "video").source_payload == before
    repeated = client.get("/api/videos/video").json()
    assert repeated["fetched_at"] == original["fetched_at"]


def test_no_video_is_404_not_empty_success(client, adapter):
    adapter.video = None
    response = client.get("/api/videos/video")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "video_not_found"


def test_corrupt_video_cache_requires_a_real_source_refresh(client, adapter, database):
    adapter.video = make_video("video", 180)
    client.get("/api/videos/video")
    session, _ = database
    row = session.get(Video, "video")
    row.source_payload = {"not_a_video": True}
    session.commit()
    before = len(adapter.calls)
    response = client.get("/api/videos/video")
    assert response.status_code == 200
    assert response.json()["from_cache"] is False
    assert len(adapter.calls) == before + 1


def test_cold_video_sample_failure_does_not_persist_partial_video(client, adapter, database):
    adapter.upload_pages = {None: RuntimeError("source sample failure")}
    response = client.get("/api/videos/video")
    assert response.status_code == 502
    session, _ = database
    # In production get_db closes/rolls back on the failed request; mirror that fixture lifetime here.
    session.rollback()
    assert session.scalars(select(Video)).all() == []
    assert session.scalars(select(ChannelAnalysis)).all() == []

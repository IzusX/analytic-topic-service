from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import pytest

from app.adapters.base import AdapterChannel, AdapterVideo, AdapterVideoPage, DataSourceAdapter
from app.adapters.youtube import YouTubeAdapter, _duration_seconds


class FakeRequest:
    def __init__(self, service, operation):
        self.service = service
        self.operation = operation

    def execute(self):
        self.service.executed.append(self.operation)
        responses = self.service.responses.get(self.operation, [])
        assert responses, f"Unexpected {self.operation}.list execute"
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FakeResource:
    def __init__(self, service, operation):
        self.service = service
        self.operation = operation

    def list(self, **kwargs):
        self.service.calls.append((self.operation, kwargs))
        return FakeRequest(self.service, self.operation)


class FakeDiscoveryService:
    def __init__(self, **responses):
        self.responses = responses
        self.calls = []
        self.executed = []

    def search(self):
        return FakeResource(self, "search")

    def videos(self):
        return FakeResource(self, "videos")

    def channels(self):
        return FakeResource(self, "channels")

    def playlistItems(self):
        return FakeResource(self, "playlistItems")


def _video_item(video_id, duration="PT4M", channel_id="channel", channel_title="Channel"):
    return {
        "id": video_id,
        "snippet": {
            "title": f"Video {video_id}",
            "publishedAt": "2025-01-02T03:04:05Z",
            "channelId": channel_id,
            "channelTitle": channel_title,
            "thumbnails": {"high": {"url": f"https://example.invalid/{video_id}.jpg"}},
        },
        "statistics": {"viewCount": "0", "likeCount": "2", "commentCount": "3"},
        "contentDetails": {} if duration is None else {"duration": duration},
    }


def _channel_item(channel_id, statistics=None):
    return {
        "id": channel_id,
        "snippet": {
            "title": f"Channel {channel_id}",
            "description": "Description",
            "publishedAt": "2020-01-02T03:04:05Z",
            "country": "US",
            "thumbnails": {"medium": {"url": f"https://example.invalid/{channel_id}.jpg"}},
        },
        "statistics": statistics if statistics is not None else {
            "subscriberCount": "10", "hiddenSubscriberCount": False,
            "viewCount": "20", "videoCount": "30",
        },
        "contentDetails": {"relatedPlaylists": {"uploads": f"uploads-{channel_id}"}},
    }


def _search_item(video_id, channel_id="channel", channel_title="Channel"):
    return {
        "id": {"videoId": video_id},
        "snippet": {"channelId": channel_id, "channelTitle": channel_title},
    }


def _playlist_item(video_id):
    return {"contentDetails": {"videoId": video_id}}


def test_adapter_contract_defaults_and_service_injection():
    video = AdapterVideo(id="video", title="Video", published_at=None, duration=None)
    channel = AdapterChannel(
        id="channel", title="Channel", description="", published_at=None, country=None,
        subscriber_count=None, view_count=None, video_count=None, uploads_playlist_id=None,
    )
    first = AdapterVideoPage(videos=[video])
    second = AdapterVideoPage(videos=[])
    first.channels.append(channel)

    assert video.duration_seconds is None
    assert video.channel_subscriber_count_hidden is None
    assert not hasattr(video, "is_shorts")
    assert channel.subscriber_count_hidden is None
    assert first.next_page_token is None
    assert first.items_scanned == 0
    assert second.channels == []
    assert "get_uploads_page" in DataSourceAdapter.__abstractmethods__
    service = FakeDiscoveryService()
    adapter = YouTubeAdapter("", service=service)
    assert adapter._service is service
    assert adapter.quota_used_estimate == 0
    assert service.calls == []


@pytest.mark.parametrize("resource,parameters,path", [
    ("channels", {"part": "snippet", "id": "channel"}, "/youtube/v3/channels"),
    ("videos", {"part": "snippet", "id": "video"}, "/youtube/v3/videos"),
    ("playlistItems", {"part": "contentDetails", "playlistId": "uploads"}, "/youtube/v3/playlistItems"),
    ("search", {"part": "snippet", "type": "video", "order": "relevance"}, "/youtube/v3/search"),
])
def test_sdk_transport_uses_verified_bounded_shared_google_root(resource, parameters, path):
    # Real SDK request construction remains offline under the network-blocking fixture.
    adapter = YouTubeAdapter("fake-key")
    http = adapter._service._http
    assert http.timeout == 15
    assert http.disable_ssl_certificate_validation is False
    request = getattr(adapter._service, resource)().list(**parameters)
    parsed = urlsplit(request.uri)
    assert parsed.scheme == "https"
    assert parsed.hostname == "www.googleapis.com"
    assert parsed.path == path  # No duplicated youtube/v3 prefix.
    assert adapter.quota_used_estimate == 0


@pytest.mark.parametrize("duration,expected", [
    ("PT0S", 0), ("PT0M", 0), ("PT0H", 0), ("P0D", 0), ("P0DT0H0M0S", 0),
    ("PT59S", 59), ("PT60S", 60), ("PT61S", 61),
    ("PT179S", 179), ("PT180S", 180), ("PT181S", 181),
    ("PT3M", 180), ("PT3M1S", 181), ("PT5M33S", 333),
    ("PT1H", 3600), ("PT1H2M3S", 3723), ("PT60M", 3600),
    ("P1D", 86400), ("P1DT0S", 86400), ("P2DT3H4M5S", 183845),
])
def test_duration_seconds_accepts_complete_fixed_units(duration, expected):
    assert _duration_seconds(duration) == expected


@pytest.mark.parametrize("duration", [
    None, "", "P", "PT", "P1DT", "P0DT", "PT3Mtrailing", "PT3M\n",
    "PT3M1Sgarbage", "P1Dtrailing", " P1D", "PT1S ", "pt1s",
    "3M", "P1H", "P1M", "P1Y", "P1W", "PT1D", "P1DT1D",
    "PT-1S", "PT1.5S", "PT1S1M", "PT1M1M", "PT１S",
])
def test_duration_seconds_rejects_incomplete_or_unsupported_values(duration):
    assert _duration_seconds(duration) is None


@pytest.mark.parametrize("kwargs", [{}, {"query": ""}, {"query": " \t\n "}])
def test_search_blank_query_omits_q_region_and_optional_parameters(kwargs):
    service = FakeDiscoveryService(search=[{"items": [], "nextPageToken": "next"}])
    adapter = YouTubeAdapter("fake-key", service=service)

    page = adapter.search_videos(**kwargs)

    assert isinstance(page, AdapterVideoPage)
    assert page.videos == []
    assert page.channels == []
    assert page.next_page_token == "next"
    assert page.items_scanned == 0
    assert service.calls == [("search", {
        "part": "snippet", "type": "video", "maxResults": 50, "order": "relevance",
    })]
    assert service.executed == ["search"]
    assert adapter.quota_used_estimate == 100


def test_search_one_page_preserves_candidates_order_and_fetched_channels(monkeypatch):
    raw = [
        _search_item("short", "hidden"), {}, _search_item("deleted"),
        _search_item("boundary", "zero"), _search_item("long", "hidden"),
        _search_item("unknown-duration", "unknown", "Fallback channel"),
    ]
    service = FakeDiscoveryService(
        search=[{"items": raw, "nextPageToken": "out-token"}],
        videos=[{"items": [
            _video_item("unknown-duration", None, None, None),
            _video_item("long", "PT181S", "hidden"),
            _video_item("boundary", "PT180S", "zero"),
            _video_item("short", "PT60S", "hidden"),
        ]}],
        channels=[{"items": [
            _channel_item("unknown", {"subscriberCount": "12"}),
            _channel_item("zero", {"subscriberCount": "0", "hiddenSubscriberCount": False}),
            _channel_item("hidden", {"subscriberCount": "999", "hiddenSubscriberCount": True}),
        ]}],
    )
    adapter = YouTubeAdapter("fake-key", service=service)
    get_channels = adapter._get_channels_by_ids
    fetched = []

    def capture_channels(ids):
        fetched.append(get_channels(ids))
        return fetched[-1]

    monkeypatch.setattr(adapter, "_get_channels_by_ids", capture_channels)
    page = adapter.search_videos(
        query="  topic  ", limit=12,
        published_after=datetime(2025, 1, 1, 3, tzinfo=timezone(timedelta(hours=3))),
        published_before=datetime(2025, 2, 1, tzinfo=timezone.utc),
        relevance_language="en", page_token="in-token",
    )

    assert [v.id for v in page.videos] == ["short", "boundary", "long", "unknown-duration"]
    assert [v.duration_seconds for v in page.videos] == [60, 180, 181, None]
    assert page.items_scanned == len(raw)
    assert page.next_page_token == "out-token"
    assert page.channels is fetched[0]
    assert [ch.id for ch in page.channels] == ["hidden", "zero", "unknown"]
    assert [v.channel_subscriber_count for v in page.videos] == [None, 0, None, 12]
    assert [v.channel_subscriber_count_hidden for v in page.videos] == [True, False, True, None]
    assert page.videos[-1].channel_id == "unknown"
    assert page.videos[-1].channel_title == "Fallback channel"
    assert service.calls == [
        ("search", {
            "part": "snippet", "type": "video", "maxResults": 12, "order": "relevance",
            "q": "topic", "publishedAfter": "2025-01-01T00:00:00Z",
            "publishedBefore": "2025-02-01T00:00:00Z", "relevanceLanguage": "en",
            "pageToken": "in-token",
        }),
        ("videos", {"part": "snippet,statistics,contentDetails",
                    "id": "short,deleted,boundary,long,unknown-duration"}),
        ("channels", {"part": "snippet,statistics,contentDetails", "id": "hidden,zero,unknown"}),
    ]
    assert service.executed == ["search", "videos", "channels"]
    assert adapter.quota_used_estimate == 102


@pytest.mark.parametrize("raw,video_responses,cost", [
    ([{}, {"id": {}}], [], 100),
    ([_search_item("deleted")], [{"items": []}], 101),
])
def test_search_unavailable_results_keep_raw_count_and_next_token(raw, video_responses, cost):
    service = FakeDiscoveryService(
        search=[{"items": raw, "nextPageToken": "continue"}], videos=video_responses,
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    page = adapter.search_videos(limit=200)

    assert page.videos == []
    assert page.channels == []
    assert page.items_scanned == len(raw)
    assert page.next_page_token == "continue"
    assert service.calls[0][1]["maxResults"] == 50
    assert len(service.calls) == (1 if cost == 100 else 2)
    assert adapter.quota_used_estimate == cost


def test_search_pagination_is_explicit_even_for_empty_pages():
    service = FakeDiscoveryService(search=[
        {"items": [], "nextPageToken": "second"}, {"items": []},
    ])
    adapter = YouTubeAdapter("fake-key", service=service)

    first = adapter.search_videos()
    assert len(service.calls) == 1
    second = adapter.search_videos(page_token=first.next_page_token)

    assert second.next_page_token is None
    assert "pageToken" not in service.calls[0][1]
    assert service.calls[1][1]["pageToken"] == "second"
    assert adapter.quota_used_estimate == 200


@pytest.mark.parametrize("statistics,count,hidden", [
    ({"subscriberCount": "999", "hiddenSubscriberCount": True}, None, True),
    ({"hiddenSubscriberCount": True}, None, True),
    ({"subscriberCount": "0", "hiddenSubscriberCount": False}, 0, False),
    ({"hiddenSubscriberCount": False}, None, False),
    ({"subscriberCount": "12"}, 12, None),
    ({"subscriberCount": "0"}, 0, None),
    ({}, None, None),
    ({"subscriberCount": "12", "hiddenSubscriberCount": "true"}, 12, None),
])
def test_single_video_preserves_hidden_zero_and_unknown_subscribers(statistics, count, hidden):
    service = FakeDiscoveryService(
        videos=[{"items": [_video_item("video", None, channel_title=None)]}],
        channels=[{"items": [_channel_item("channel", statistics)]}],
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    video = adapter.get_video("video")

    assert video.channel_subscriber_count == count
    assert video.channel_subscriber_count_hidden is hidden
    assert video.channel_title == "Channel channel"
    assert video.duration is None
    assert video.duration_seconds is None
    assert video.title == "Video video"
    assert video.published_at == datetime(2025, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert (video.view_count, video.like_count, video.comment_count) == (0, 2, 3)
    assert video.thumbnail_url == "https://example.invalid/video.jpg"
    assert adapter.quota_used_estimate == 2


def test_missing_video_or_channel_does_not_infer_subscriber_visibility():
    service = FakeDiscoveryService(
        videos=[{"items": []}, {"items": [_video_item("video")]}], channels=[{"items": []}],
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    assert adapter.get_video("deleted") is None
    assert adapter.quota_used_estimate == 1
    video = adapter.get_video("video")
    assert video.channel_subscriber_count is None
    assert video.channel_subscriber_count_hidden is None
    assert service.executed == ["videos", "videos", "channels"]
    assert adapter.quota_used_estimate == 3


def test_batch_enrichment_restores_input_id_order_and_counts_each_request():
    ids = [f"id-{i}" for i in range(101)]
    service = FakeDiscoveryService(
        videos=[{"items": [_video_item(vid) for vid in reversed(ids[i:i+50]) if vid != "id-1"]}
                for i in range(0, len(ids), 50)],
        channels=[{"items": [_channel_item(cid) for cid in reversed(ids[i:i+50]) if cid != "id-1"]}
                  for i in range(0, len(ids), 50)],
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    videos = adapter._get_videos_by_ids(ids)
    channels = adapter._get_channels_by_ids(ids)

    assert [v.id for v in videos] == [vid for vid in ids if vid != "id-1"]
    assert [ch.id for ch in channels] == [cid for cid in ids if cid != "id-1"]
    assert [len(kwargs["id"].split(",")) for _, kwargs in service.calls] == [50, 50, 1, 50, 50, 1]
    assert adapter.quota_used_estimate == 6


def test_search_channels_and_get_channel_remain_public_and_ordered():
    service = FakeDiscoveryService(
        search=[{"items": [{"id": {"channelId": "second"}}, {"snippet": {"channelId": "first"}}]}],
        channels=[{"items": [_channel_item("first"), _channel_item("second")]},
                  {"items": [_channel_item("first")]}],
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    channels = adapter.search_channels("topic")
    channel = adapter.get_channel("first")

    assert [ch.id for ch in channels] == ["second", "first"]
    assert channel.description == "Description"
    assert channel.country == "US"
    assert channel.uploads_playlist_id == "uploads-first"
    assert (channel.subscriber_count, channel.view_count, channel.video_count) == (10, 20, 30)
    assert channel.subscriber_count_hidden is False
    assert channel.thumbnail_url == "https://example.invalid/first.jpg"
    assert adapter.quota_used_estimate == 102


def test_uploads_one_page_counts_missing_records_and_preserves_playlist_order():
    raw = [
        _playlist_item("short"), {}, _playlist_item("deleted"), _playlist_item("boundary"),
        _playlist_item("long"), _playlist_item("unknown-duration"),
    ]
    service = FakeDiscoveryService(
        playlistItems=[{"items": raw, "nextPageToken": "out-token"}],
        videos=[{"items": [
            _video_item("unknown-duration", None), _video_item("long", "P1D"),
            _video_item("boundary", "PT180S"), _video_item("short", "PT0S"),
        ]}],
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    page = adapter.get_uploads_page("uploads", page_token="in-token", limit=7)

    assert [v.id for v in page.videos] == ["short", "boundary", "long", "unknown-duration"]
    assert [v.duration_seconds for v in page.videos] == [0, 180, 86400, None]
    assert page.items_scanned == 6
    assert page.next_page_token == "out-token"
    assert page.channels == []
    assert service.calls == [
        ("playlistItems", {"part": "contentDetails", "playlistId": "uploads",
                           "maxResults": 7, "pageToken": "in-token"}),
        ("videos", {"part": "snippet,statistics,contentDetails",
                    "id": "short,deleted,boundary,long,unknown-duration"}),
    ]
    assert service.executed == ["playlistItems", "videos"]
    assert adapter.quota_used_estimate == 2


@pytest.mark.parametrize("raw,video_responses,cost", [
    ([], [], 1), ([{}, {"contentDetails": {}}], [], 1),
    ([_playlist_item("deleted")], [{"items": []}], 2),
])
def test_uploads_empty_or_unavailable_page_keeps_token(raw, video_responses, cost):
    service = FakeDiscoveryService(
        playlistItems=[{"items": raw, "nextPageToken": "continue"}], videos=video_responses,
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    page = adapter.get_uploads_page("uploads", limit=200)

    assert page.videos == []
    assert page.items_scanned == len(raw)
    assert page.next_page_token == "continue"
    assert service.calls[0][1] == {"part": "contentDetails", "playlistId": "uploads", "maxResults": 50}
    assert len(service.calls) == cost
    assert adapter.quota_used_estimate == cost


def test_generic_get_videos_returns_unfiltered_list_bounded_to_200_raw_records():
    playlist_responses = []
    video_responses = []
    expected_ids = []
    for i in range(4):
        ids = [f"video-{i * 50 + j}" for j in range(49)]
        playlist_responses.append({
            "items": [{}] + [_playlist_item(vid) for vid in ids],
            "nextPageToken": f"page-{i + 2}",
        })
        available = ids[1:]
        expected_ids.extend(available)
        video_responses.append({"items": [
            _video_item(vid, None if vid == "video-198" else "PT60S") for vid in reversed(available)
        ]})
    service = FakeDiscoveryService(
        channels=[{"items": [_channel_item("channel")]}],
        playlistItems=playlist_responses, videos=video_responses,
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    videos = adapter.get_videos("channel", limit=500)

    assert isinstance(videos, list)
    assert [v.id for v in videos] == expected_ids
    assert len(videos) == 192
    assert videos[0].duration_seconds == 60
    assert videos[-1].duration_seconds is None
    playlist_calls = [kwargs for operation, kwargs in service.calls if operation == "playlistItems"]
    assert [kwargs["maxResults"] for kwargs in playlist_calls] == [50, 50, 50, 50]
    assert [kwargs.get("pageToken") for kwargs in playlist_calls] == [None, "page-2", "page-3", "page-4"]
    assert adapter.quota_used_estimate == 9


def test_generic_get_videos_uses_raw_count_for_remaining_limit_not_available_videos():
    ids = [f"video-{i}" for i in range(55)]
    service = FakeDiscoveryService(
        channels=[{"items": [_channel_item("channel")]}],
        playlistItems=[
            {"items": [{}] + [_playlist_item(vid) for vid in ids[:49]], "nextPageToken": "second"},
            {"items": [_playlist_item(vid) for vid in ids[50:]], "nextPageToken": "third"},
        ],
        videos=[{"items": [_video_item(vid) for vid in reversed(ids[1:49])]},
                {"items": [_video_item(vid) for vid in reversed(ids[50:])]}],
    )
    adapter = YouTubeAdapter("fake-key", service=service)

    videos = adapter.get_videos("channel", limit=55)

    assert [v.id for v in videos] == ids[1:49] + ids[50:]
    playlist_calls = [kwargs for operation, kwargs in service.calls if operation == "playlistItems"]
    assert [kwargs["maxResults"] for kwargs in playlist_calls] == [50, 5]
    assert adapter.quota_used_estimate == 5


@pytest.mark.parametrize("operation,cost", [("search", 100), ("videos", 101), ("channels", 102)])
def test_search_quota_counts_attempted_execute_even_when_request_fails(operation, cost):
    responses = {
        "search": [{"items": [_search_item("video")]}],
        "videos": [{"items": [_video_item("video")]}],
        "channels": [{"items": [_channel_item("channel")]}],
    }
    responses[operation] = [RuntimeError("fake API failure")]
    service = FakeDiscoveryService(**responses)
    adapter = YouTubeAdapter("fake-key", service=service)

    with pytest.raises(RuntimeError, match="fake API failure"):
        adapter.search_videos()

    assert service.executed[-1] == operation
    assert adapter.quota_used_estimate == cost


def test_uploads_quota_counts_failed_playlist_execute():
    service = FakeDiscoveryService(playlistItems=[RuntimeError("fake API failure")])
    adapter = YouTubeAdapter("fake-key", service=service)

    with pytest.raises(RuntimeError, match="fake API failure"):
        adapter.get_uploads_page("uploads")

    assert service.executed == ["playlistItems"]
    assert adapter.quota_used_estimate == 1

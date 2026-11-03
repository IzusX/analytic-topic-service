from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.schemas.video import SearchVideosRequest
from app.services.search import freeze_search, matches_filters
from conftest import make_video


@pytest.mark.parametrize("seconds,expected", [
    (0, "up_to_3m"), (1, "up_to_3m"), (179, "up_to_3m"), (180, "up_to_3m"),
    (181, "3_to_10m"), (599, "3_to_10m"), (600, "3_to_10m"),
    (601, "10_to_30m"), (1799, "10_to_30m"), (1800, "10_to_30m"),
    (1801, "30_to_60m"), (3599, "30_to_60m"), (3600, "30_to_60m"),
    (3601, "over_60m"), (86400, "over_60m"),
])
def test_exact_duration_bins(seconds, expected):
    from app.schemas.common import DURATION_RANGES
    video = make_video("v", seconds=seconds)
    for name in DURATION_RANGES:
        assert matches_filters(video, SearchVideosRequest(duration_ranges=[name])) == (name == expected)


def test_union_unknown_duration_and_normalized_order():
    req = SearchVideosRequest(duration_ranges=["10_to_30m", "3_to_10m", "3_to_10m"])
    assert req.duration_ranges == ["3_to_10m", "10_to_30m"]
    assert matches_filters(make_video("v", 1800), req)
    assert not matches_filters(make_video("v", 1801), req)
    assert not matches_filters(make_video("v", None), req)
    assert matches_filters(make_video("v", None), SearchVideosRequest())


@pytest.mark.parametrize("bounds", [{"min_subscribers": 0}, {"max_subscribers": 1000}, {"min_subscribers": 1, "max_subscribers": 1000}])
def test_unknown_subscribers_excluded_only_with_active_bounds(bounds):
    video = make_video("v", subscribers=None)
    assert not matches_filters(video, SearchVideosRequest(**bounds))
    assert matches_filters(video, SearchVideosRequest())


def test_zero_counts_and_explicit_hidden_flag():
    video = make_video("v", views=0, subscribers=0)
    assert matches_filters(video, SearchVideosRequest(min_views=0, max_views=0, min_subscribers=0, max_subscribers=0))
    video.channel_subscriber_count_hidden = True
    assert not matches_filters(video, SearchVideosRequest(min_subscribers=0))
    assert matches_filters(video, SearchVideosRequest())


@pytest.mark.parametrize("values", [
    {"min_views": -1}, {"min_subscribers": -1}, {"limit": 51}, {"limit": 0}, {"limit": True},
    {"min_subscribers": 1.5}, {"max_views": True}, {"min_views": 2, "max_views": 1},
    {"min_subscribers": 2, "max_subscribers": 1}, {"duration_ranges": ["shorts"]},
    {"relevance_language": "zz"}, {"relevance_language": "zh"}, {"page_token": "bad token"},
    {"page_token": "\x00token"}, {"page_token": ""}, {"page_token": "x" * 2049},
    {"period": "decade"}, {"query": "x" * 501},
    {"published_after": "2024-01-01T00:00:00"},
    {"published_after": "2024-01-02T00:00:00Z", "published_before": "2024-01-01T00:00:00Z"},
    {"page_token": "next", "period": "month"}, {"regionCode": "RU"},
])
def test_request_rejects_invalid_values(values):
    with pytest.raises(ValidationError):
        SearchVideosRequest(**values)


@pytest.mark.parametrize("language", [None, "", "ru", "en", "zh-Hans", "zh-Hant"])
def test_language_codes_and_optional_query(language):
    req = SearchVideosRequest(query="  ", relevance_language=language)
    assert req.query == ""
    assert req.relevance_language == (language or None)


@pytest.mark.parametrize("now,period,expected", [
    ("2024-03-31T12:30:00+00:00", "month", "2024-02-29T12:30:00+00:00"),
    ("2023-03-31T12:30:00+00:00", "month", "2023-02-28T12:30:00+00:00"),
    ("2024-02-29T12:30:00+00:00", "year", "2023-02-28T12:30:00+00:00"),
    ("2024-04-01T12:30:00+00:00", "day", "2024-03-31T12:30:00+00:00"),
    ("2024-04-01T12:30:00+00:00", "week", "2024-03-25T12:30:00+00:00"),
])
def test_frozen_periods(now, period, expected):
    result = freeze_search(SearchVideosRequest(period=period), datetime.fromisoformat(now))
    assert result.published_after == datetime.fromisoformat(expected)


def test_pagination_keeps_boundary_and_refresh_recomputes():
    now = datetime(2024, 3, 31, tzinfo=timezone.utc)
    first = freeze_search(SearchVideosRequest(period="month"), now)
    following = SearchVideosRequest(**{**first.model_dump(), "page_token": "next"})
    assert freeze_search(following, now + timedelta(days=2)).published_after == first.published_after
    refreshed = freeze_search(SearchVideosRequest(period="month"), now + timedelta(days=2))
    assert refreshed.published_after != first.published_after


def test_utc_conversion_before_calendar_subtraction():
    now = datetime(2024, 4, 1, 1, tzinfo=timezone(timedelta(hours=3)))
    result = freeze_search(SearchVideosRequest(period="month"), now)
    assert result.published_after == datetime(2024, 2, 29, 22, tzinfo=timezone.utc)

"""Frozen search boundaries and exact postfilters for one source page."""
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta

from ..schemas.common import DURATION_RANGES, as_utc
from ..schemas.video import SearchVideosRequest


def freeze_search(req: SearchVideosRequest, now: datetime) -> SearchVideosRequest:
    after = as_utc(req.published_after)
    if after is None and req.period != "all":
        delta = {
            "day": timedelta(hours=24), "week": timedelta(days=7),
            "month": relativedelta(months=1), "year": relativedelta(years=1),
        }[req.period]
        after = as_utc(now) - delta
    result = req.model_copy(update={"published_after": after, "published_before": as_utc(req.published_before)})
    # Validate a newly computed boundary against the optional upper date too.
    return SearchVideosRequest.model_validate(result.model_dump())


def matches_filters(video, req: SearchVideosRequest) -> bool:
    for name, count in (("views", video.view_count), ("subscribers", video.channel_subscriber_count)):
        lower, upper = getattr(req, f"min_{name}"), getattr(req, f"max_{name}")
        if lower is None and upper is None:
            continue
        if count is None or (name == "subscribers" and video.channel_subscriber_count_hidden is True):
            return False
        if lower is not None and count < lower:
            return False
        if upper is not None and count > upper:
            return False
    if req.duration_ranges:
        seconds = video.duration_seconds
        if seconds is None:
            return False
        return any(
            (lower is None or seconds > lower) and (upper is None or seconds <= upper)
            for lower, upper in (DURATION_RANGES[name] for name in req.duration_ranges)
        )
    return True

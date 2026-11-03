"""Convert source snapshots to public numbers without stale-field fallback."""
from ..schemas.common import as_utc
from ..schemas.video import VideoOut
from .metrics import anomaly_ratio, comment_view_ratio, like_view_ratio, view_sub_ratio


def video_out(video, median: float | None = None) -> VideoOut:
    result = VideoOut.model_validate(video)
    result.published_at = as_utc(result.published_at)
    if result.channel_subscriber_count_hidden is True:
        result.channel_subscriber_count = None
    result.view_sub_ratio = view_sub_ratio(result.view_count, result.channel_subscriber_count)
    result.like_view_ratio = like_view_ratio(result.like_count, result.view_count)
    result.comment_view_ratio = comment_view_ratio(result.comment_count, result.view_count)
    result.view_median_ratio = anomaly_ratio(result.view_count, median)
    return result

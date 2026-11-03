"""Descriptive metrics for explicitly selected videos.

- medianViews, meanViews, population std, cv=std/mean, spikeRatio=max/median
- consistency = fraction with views >= 0.5*median
- view/sub, like/view, comment/view, views/median

Selection rules live outside these formulas. No success verdict or sufficiency threshold.
"""
from __future__ import annotations
import statistics
from dataclasses import dataclass


@dataclass
class ChannelMetrics:
    count: int
    median_views: float | None
    mean_views: float | None
    std_views: float | None
    cv: float | None
    spike_ratio: float | None
    consistency: float | None  # доля видео >= 0.5*median
    max_views: int | None
    min_views: int | None


def _views_list(videos) -> list[int]:
    """videos: iterable of objects/dicts with view_count."""
    values = []
    for video in videos:
        count = video.view_count if hasattr(video, "view_count") else video.get("view_count")
        if count is not None and count >= 0:
            values.append(int(count))
    return values


def median_views(views: list[int]) -> float | None:
    return float(statistics.median(views)) if views else None


def mean_views(views: list[int]) -> float | None:
    return float(statistics.mean(views)) if views else None


def std_views(views: list[int]) -> float | None:
    # Population standard deviation; one observed value has deviation zero.
    return float(statistics.pstdev(views)) if views else None


def cv_value(std: float | None, mean: float | None) -> float | None:
    return safe_ratio(std, mean)


def spike_ratio_value(max_views: int | None, median: float | None) -> float | None:
    return safe_ratio(max_views, median)


def consistency_ratio(views: list[int], median: float | None) -> float | None:
    if not views or median is None:
        return None
    # A zero median still defines the threshold zero; this is not division by median.
    return sum(value >= median * 0.5 for value in views) / len(views)


def channel_metrics(videos) -> ChannelMetrics:
    views = _views_list(videos)
    if not views:
        return ChannelMetrics(0, None, None, None, None, None, None, None, None)
    median, mean, std = median_views(views), mean_views(views), std_views(views)
    return ChannelMetrics(
        count=len(views), median_views=median, mean_views=mean, std_views=std,
        cv=cv_value(std, mean), spike_ratio=spike_ratio_value(max(views), median),
        consistency=consistency_ratio(views, median), max_views=max(views), min_views=min(views),
    )


def safe_ratio(numerator: int | float | None, denominator: int | float | None) -> float | None:
    if numerator is None or numerator < 0 or denominator is None or denominator <= 0:
        return None
    return numerator / denominator


def like_view_ratio(like_count: int | None, view_count: int | None) -> float | None:
    return safe_ratio(like_count, view_count)


def comment_view_ratio(comment_count: int | None, view_count: int | None) -> float | None:
    return safe_ratio(comment_count, view_count)


def view_sub_ratio(view_count: int | None, subs: int | None) -> float | None:
    return safe_ratio(view_count, subs)


def anomaly_ratio(view_count: int | None, median: float | None) -> float | None:
    """Numerical comparison only; retained helper name, no anomaly verdict."""
    return safe_ratio(view_count, median)

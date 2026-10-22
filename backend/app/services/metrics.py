"""Метрики для карточки видео (1.2) и канала (1.3).

Источники:
- medianViews, meanViews, std, cv=std/mean, spikeRatio=max/median, consistency=>=0.5*median
- view/sub, like/view, comment/view, anomaly=views/median
- Пороги из Settings: spike_ratio_threshold=5.0, cv_threshold=1.0, min_median_views=1000
"""
from __future__ import annotations
import math
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
    out: list[int] = []
    for v in videos:
        vc = v.view_count if hasattr(v, "view_count") else v.get("view_count")
        if vc is not None and vc >= 0:
            out.append(int(vc))
    return out


def median_views(views: list[int]) -> float | None:
    if not views:
        return None
    return float(statistics.median(views))


def mean_views(views: list[int]) -> float | None:
    if not views:
        return None
    return float(statistics.mean(views))


def std_views(views: list[int]) -> float | None:
    if len(views) < 2:
        return 0.0 if views else None
    # population std — стабильнее на малых выборках канала (30 точек)
    return float(statistics.pstdev(views))


def cv_value(std: float | None, mean: float | None) -> float | None:
    if std is None or mean is None or mean == 0:
        return None
    return std / mean


def spike_ratio_value(max_views: int | None, median: float | None) -> float | None:
    if max_views is None or median is None or median == 0:
        return None
    return max_views / median


def consistency_ratio(views: list[int], median: float | None) -> float | None:
    if not views or median is None or median == 0:
        return None
    thr = median * 0.5
    ok = sum(1 for v in views if v >= thr)
    return ok / len(views)


def channel_metrics(videos) -> ChannelMetrics:
    views = _views_list(videos)
    if not views:
        return ChannelMetrics(0, None, None, None, None, None, None, None, None)
    med = median_views(views)
    mean = mean_views(views)
    std = std_views(views)
    return ChannelMetrics(
        count=len(views),
        median_views=med,
        mean_views=mean,
        std_views=std,
        cv=cv_value(std, mean),
        spike_ratio=spike_ratio_value(max(views), med),
        consistency=consistency_ratio(views, med),
        max_views=max(views),
        min_views=min(views),
    )


def like_view_ratio(like_count: int | None, view_count: int | None) -> float | None:
    if like_count is None or view_count is None or view_count == 0:
        return None
    return like_count / view_count


def comment_view_ratio(comment_count: int | None, view_count: int | None) -> float | None:
    if comment_count is None or view_count is None or view_count == 0:
        return None
    return comment_count / view_count


def view_sub_ratio(view_count: int | None, subs: int | None) -> float | None:
    if view_count is None or not subs:
        return None
    return view_count / subs


def anomaly_ratio(view_count: int | None, median: float | None) -> float | None:
    if view_count is None or median is None or median == 0:
        return None
    return view_count / median


def is_anomaly(view_count: int | None, median: float | None, threshold: float = 3.0) -> bool | None:
    r = anomaly_ratio(view_count, median)
    if r is None:
        return None
    return r >= threshold

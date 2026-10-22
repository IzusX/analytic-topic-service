from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel, Field
from .video import VideoOut

class ChannelOut(BaseModel):
    id: str
    title: str
    description: str | None = None
    published_at: datetime | None = None
    country: str | None = None
    subscriber_count: int | None = None
    view_count: int | None = None
    video_count: int | None = None
    thumbnail_url: str | None = None
    uploads_playlist_id: str | None = None
    last_synced_at: datetime | None = None

    class Config:
        from_attributes = True

class ChannelMetricsOut(BaseModel):
    count: int = Field(description="Сколько LONG-видео учтено (<=30)")
    median_views: float | None = None
    mean_views: float | None = None
    std_views: float | None = None
    cv: float | None = Field(default=None, description="std/mean")
    spike_ratio: float | None = Field(default=None, description="max/median")
    consistency: float | None = Field(default=None, description="доля видео >= 0.5*median")
    max_views: int | None = None
    min_views: int | None = None
    avg_like_view: float | None = None
    avg_comment_view: float | None = None
    # thresholds echo
    spike_ratio_threshold: float = 5.0
    cv_threshold: float = 1.0
    min_median_views: int = 1000
    verdict: str = Field(description="stable | spike | insufficient_data")

class ChannelCardOut(BaseModel):
    channel: ChannelOut
    metrics: ChannelMetricsOut
    videos: list[VideoOut] = Field(description="Последние 30 LONG-видео для графика (отсортир. по дате)")
    quota_used_estimate: int | None = None

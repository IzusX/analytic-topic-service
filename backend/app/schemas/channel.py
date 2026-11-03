from __future__ import annotations
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from .common import SampleMetadata, SourceVideoOut
from .video import VideoOut


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    description: str | None = None
    published_at: datetime | None = None
    country: str | None = None
    subscriber_count: int | None = None
    subscriber_count_hidden: bool | None = None
    view_count: int | None = None
    video_count: int | None = None
    thumbnail_url: str | None = None
    uploads_playlist_id: str | None = None
    last_synced_at: datetime | None = None


class ChannelMetricsOut(BaseModel):
    count: int = Field(description="Selected videos with known views; no minimum sample threshold")
    median_views: float | None = None
    mean_views: float | None = None
    std_views: float | None = None
    cv: float | None = Field(default=None, description="Population std / mean")
    spike_ratio: float | None = Field(default=None, description="Maximum / median")
    consistency: float | None = Field(default=None, description="Fraction with views >= 0.5 * median")
    max_views: int | None = None
    min_views: int | None = None
    avg_like_view: float | None = None
    avg_comment_view: float | None = None
    like_view_count: int = 0
    comment_view_count: int = 0


class ChannelCardOut(BaseModel):
    channel: ChannelOut
    sample: SampleMetadata
    metrics: ChannelMetricsOut
    summary: str
    videos: list[VideoOut] = Field(description="Confirmed selected videos, including unknown view counts; oldest to newest, unknown dates last")
    source_video: SourceVideoOut | None = None
    fetched_at: datetime
    from_cache: bool = False
    quota_used_estimate: int = 0

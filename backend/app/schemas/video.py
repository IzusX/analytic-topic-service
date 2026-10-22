from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel, Field

class VideoOut(BaseModel):
    id: str
    title: str
    published_at: datetime | None = None
    duration: str | None = None
    is_shorts: bool = False
    view_count: int | None = None
    like_count: int | None = None
    comment_count: int | None = None
    thumbnail_url: str | None = None
    channel_id: str | None = None
    channel_title: str | None = None
    channel_subscriber_count: int | None = None
    # derived — counts/user engagement
    view_sub_ratio: float | None = None
    like_view_ratio: float | None = Field(default=None, description="likeCount / viewCount")
    comment_view_ratio: float | None = Field(default=None, description="commentCount / viewCount")

    class Config:
        from_attributes = True


class VideoCardOut(VideoOut):
    """Расширенная карточка видео (Этап 1.2): + аномалия vs медиана канала (LONG-only)."""
    channel_median_views: float | None = Field(default=None, description="Медиана просмотров LONG-видео канала (последние 30)")
    channel_long_count: int | None = Field(default=None, description="Сколько LONG-видео учтено в медиане")
    anomaly_ratio: float | None = Field(default=None, description="viewCount / channel_median_views")
    is_anomaly: bool | None = Field(default=None, description="True если anomaly_ratio >= 3.0")
    anomaly_threshold: float = 3.0


class SearchVideosRequest(BaseModel):
    query: str
    limit: int = Field(default=20, ge=1, le=50)
    published_after: datetime | None = None
    published_before: datetime | None = None
    relevance_language: str | None = None  # e.g. "ru", "en"

    # Этап 1.4 — фильтры уже в схеме, применяются на бэке после обогащения (search.list их не поддерживает)
    min_views: int | None = Field(default=None, ge=0)
    max_views: int | None = Field(default=None, ge=0)
    min_subscribers: int | None = Field(default=None, ge=0)
    max_subscribers: int | None = Field(default=None, ge=0)


class SearchVideosResponse(BaseModel):
    query: str
    videos: list[VideoOut]
    quota_used_estimate: int | None = None

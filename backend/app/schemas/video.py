from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel

class VideoOut(BaseModel):
    id: str
    title: str
    published_at: datetime | None
    duration: str | None
    is_shorts: bool = False
    view_count: int | None
    like_count: int | None
    comment_count: int | None
    thumbnail_url: str | None
    channel_id: str | None
    channel_title: str | None
    channel_subscriber_count: int | None
    # derived
    view_sub_ratio: float | None = None

    class Config:
        from_attributes = True

class SearchVideosRequest(BaseModel):
    query: str
    limit: int = 20
    published_after: datetime | None = None
    published_before: datetime | None = None
    relevance_language: str | None = None  # e.g. "ru", "en"

class SearchVideosResponse(BaseModel):
    query: str
    videos: list[VideoOut]
    quota_used_estimate: int | None = None

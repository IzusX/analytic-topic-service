from __future__ import annotations
from datetime import datetime

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from .common import (
    DURATION_RANGES, SUPPORTED_RELEVANCE_LANGUAGES, DurationRange, Period, SampleMetadata,
)


class VideoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    published_at: datetime | None = None
    duration: str | None = None
    duration_seconds: int | None = None
    view_count: int | None = None
    like_count: int | None = None
    comment_count: int | None = None
    thumbnail_url: str | None = None
    channel_id: str | None = None
    channel_title: str | None = None
    channel_subscriber_count: int | None = None
    channel_subscriber_count_hidden: bool | None = None
    # derived — counts/user engagement
    view_sub_ratio: float | None = Field(default=None, description="Views / current subscriber count")
    like_view_ratio: float | None = Field(default=None, description="likeCount / viewCount")
    comment_view_ratio: float | None = Field(default=None, description="commentCount / viewCount")
    view_median_ratio: float | None = Field(default=None, description="Views / median of the explicitly identified sample")


class VideoCardOut(VideoOut):
    """Optional direct video endpoint; no Shorts classification or success verdict."""
    channel_median_views: float | None = None
    channel_sample_count: int | None = None
    sample: SampleMetadata | None = None
    comparison_status: str
    comparison_reason: str | None = None
    fetched_at: datetime
    sample_fetched_at: datetime | None = None
    from_cache: bool = False
    quota_used_estimate: int = 0


class SearchVideosRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(default="", max_length=500)
    limit: int = Field(default=50, ge=1, le=50, strict=True)
    period: Period = "all"
    published_after: AwareDatetime | None = None
    published_before: AwareDatetime | None = None
    relevance_language: str | None = None
    page_token: str | None = Field(default=None, min_length=1, max_length=2048, pattern=r"^[^\x00-\x20\x7f]+$")
    duration_ranges: list[DurationRange] = Field(default_factory=list, max_length=5)

    # Search postfilters: search.list cannot express exact duration or subscriber ranges.
    min_views: int | None = Field(default=None, ge=0, strict=True)
    max_views: int | None = Field(default=None, ge=0, strict=True)
    min_subscribers: int | None = Field(default=None, ge=0, strict=True)
    max_subscribers: int | None = Field(default=None, ge=0, strict=True)

    @field_validator("query")
    @classmethod
    def trim_query(cls, value: str) -> str:
        return value.strip()

    @field_validator("relevance_language")
    @classmethod
    def validate_language(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        value = value.strip()
        if value not in SUPPORTED_RELEVANCE_LANGUAGES:
            raise ValueError("Unsupported relevanceLanguage code; use ISO 639-1 or zh-Hans/zh-Hant")
        return value

    @field_validator("duration_ranges")
    @classmethod
    def normalize_duration_ranges(cls, value: list[DurationRange]) -> list[DurationRange]:
        return [item for item in DURATION_RANGES if item in value]

    @model_validator(mode="after")
    def validate_bounds(self):
        for name in ("views", "subscribers"):
            lower, upper = getattr(self, f"min_{name}"), getattr(self, f"max_{name}")
            if lower is not None and upper is not None and lower > upper:
                raise ValueError(f"min_{name} must not exceed max_{name}")
        if self.published_after is not None and self.published_before is not None:
            if self.published_after >= self.published_before:
                raise ValueError("published_after must be earlier than published_before")
        if self.page_token is not None and self.period != "all" and self.published_after is None:
            raise ValueError("Pagination requires the frozen published_after from the first response")
        return self


class SearchVideosResponse(BaseModel):
    query: str
    applied: SearchVideosRequest
    videos: list[VideoOut]
    fetched_at: datetime
    next_page_token: str | None = None
    items_scanned: int
    matched_count: int
    order: str = "relevance"
    quota_used_estimate: int

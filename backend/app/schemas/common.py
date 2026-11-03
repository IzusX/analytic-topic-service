from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Period = Literal["all", "day", "week", "month", "year"]
DurationRange = Literal["up_to_3m", "3_to_10m", "10_to_30m", "30_to_60m", "over_60m"]
DURATION_RANGES = {
    "up_to_3m": (None, 180),
    "3_to_10m": (180, 600),
    "10_to_30m": (600, 1800),
    "30_to_60m": (1800, 3600),
    "over_60m": (3600, None),
}

# ISO 639-1, with the Chinese variants required by search.list documentation.
SUPPORTED_RELEVANCE_LANGUAGES = frozenset((
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy "
    "da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz "
    "ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo "
    "lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi "
    "pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti "
    "tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zu zh-Hans zh-Hant"
).split())


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    # SQLite's DateTime loader removes the timezone from stored UTC values.
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class SampleRule(BaseModel):
    model_config = ConfigDict(frozen=True)
    min_duration_seconds: int = 180
    min_duration_exclusive: bool = True
    max_videos: int = 30
    max_uploads_scanned: int = 200
    max_pages: int = 4


class SampleMetadata(BaseModel):
    rule: SampleRule = Field(default_factory=SampleRule)
    selected_count: int
    metric_count: int
    uploads_scanned: int
    pages_scanned: int
    unavailable_video_count: int = 0
    unknown_duration_count: int = 0
    excluded_duration_count: int = 0
    unknown_date_count: int = 0
    date_from: datetime | None = None
    date_to: datetime | None = None
    stop_reason: Literal["sample_full", "uploads_exhausted", "scan_limit"]
    target_reached: bool
    scan_limit_reached: bool


class SourceVideoOut(BaseModel):
    id: str
    status: Literal["included", "duration_too_short", "duration_unknown", "not_in_sample", "channel_mismatch"]
    reason: str | None = None
    view_median_ratio: float | None = None

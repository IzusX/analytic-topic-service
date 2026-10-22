"""Этап 1.2 — карточка видео: GET /api/videos/{id} с аномалией vs медиана канала.

Медиана считается по последним 30 LONG-видео канала (is_shorts=false).
Если LONG < 3 — метрики аномалии null (недостаточно данных).
Порог аномалии 3.0 вынесен как дефолт; фронт показывает бейдж при is_anomaly.
"""
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..config import settings
from ..models.channel import Channel, Video
from ..schemas.video import VideoCardOut
from ..adapters.youtube import YouTubeAdapter
from ..services.metrics import anomaly_ratio, is_anomaly, like_view_ratio, comment_view_ratio, view_sub_ratio, median_views
from ..services.sync import upsert_channel, upsert_video

router = APIRouter(prefix="/api/videos", tags=["videos"])

ANOMALY_THRESHOLD = 3.0
LONG_LIMIT_FOR_MEDIAN = 30

def _api_key(header_key: str | None) -> str:
    key = (header_key or "").strip() or settings.youtube_api_key.strip()
    if not key:
        raise HTTPException(status_code=500, detail="YOUTUBE_API_KEY not configured (backend/.env or X-YouTube-Key)")
    return key

def _to_card(av, channel_median: float | None, long_count: int | None) -> VideoCardOut:
    vc = av.view_count
    med = channel_median
    return VideoCardOut(
        id=av.id, title=av.title, published_at=av.published_at, duration=av.duration,
        is_shorts=bool(av.is_shorts), view_count=vc, like_count=av.like_count,
        comment_count=av.comment_count, thumbnail_url=av.thumbnail_url,
        channel_id=av.channel_id, channel_title=av.channel_title,
        channel_subscriber_count=av.channel_subscriber_count,
        view_sub_ratio=view_sub_ratio(vc, av.channel_subscriber_count),
        like_view_ratio=like_view_ratio(av.like_count, vc),
        comment_view_ratio=comment_view_ratio(av.comment_count, vc),
        channel_median_views=med,
        channel_long_count=long_count,
        anomaly_ratio=anomaly_ratio(vc, med),
        is_anomaly=is_anomaly(vc, med, ANOMALY_THRESHOLD),
        anomaly_threshold=ANOMALY_THRESHOLD,
    )

@router.get("/{video_id}", response_model=VideoCardOut)
def get_video_card(
    video_id: str,
    db: Session = Depends(get_db),
    x_youtube_key: str | None = Header(default=None, alias="X-YouTube-Key"),
):
    key = _api_key(x_youtube_key)
    adapter = YouTubeAdapter(key)

    # 1) try DB cache first for faster second hit
    cached = db.get(Video, video_id)
    # always fetch fresh adapter data for accuracy (statistics change) — but reuse channel median logic
    try:
        av = adapter.get_video(video_id)
    except Exception as e:
        msg = str(e)
        if "quotaExceeded" in msg or "quota" in msg.lower():
            raise HTTPException(status_code=429, detail=f"YouTube quota exceeded: {msg}")
        raise HTTPException(status_code=502, detail=f"YouTube API error: {msg}")

    if av is None:
        raise HTTPException(status_code=404, detail="Video not found")

    # upsert video + channel
    upsert_video(db, av)
    # need channel's last 30 LONG to compute median
    channel_id = av.channel_id
    channel_median: float | None = None
    long_count: int | None = None

    if channel_id:
        # try to ensure we have enough LONG videos cached — if cache thin, fetch via adapter
        cached_longs = db.query(Video).filter(Video.channel_id == channel_id, Video.is_shorts == False).order_by(Video.published_at.desc()).limit(LONG_LIMIT_FOR_MEDIAN * 2).all()
        # if not enough LONG in DB, sync from YouTube
        if len(cached_longs) < 5:
            try:
                fresh = adapter.get_videos(channel_id, limit=LONG_LIMIT_FOR_MEDIAN)
                # upsert fresh batch
                for fv in fresh:
                    upsert_video(db, fv)
                # also sync channel row
                ch = adapter.get_channel(channel_id)
                if ch:
                    upsert_channel(db, ch)
                cached_longs = db.query(Video).filter(Video.channel_id == channel_id, Video.is_shorts == False).order_by(Video.published_at.desc()).limit(LONG_LIMIT_FOR_MEDIAN).all()
            except Exception:
                # median will stay None — card still returns
                pass
        else:
            cached_longs = cached_longs[:LONG_LIMIT_FOR_MEDIAN]

        longs_for_median = [v for v in cached_longs if v.view_count is not None][:LONG_LIMIT_FOR_MEDIAN]
        long_count = len(longs_for_median)
        if long_count >= 3:
            views = [v.view_count for v in longs_for_median]
            channel_median = median_views(views)

    return _to_card(av, channel_median, long_count)

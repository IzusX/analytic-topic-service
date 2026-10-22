"""Этап 1.3 — карточка канала: GET /api/channels/{id} с метриками + 30 LONG для графика."""
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..config import settings
from ..models.channel import Channel, Video
from ..schemas.channel import ChannelOut, ChannelCardOut, ChannelMetricsOut
from ..schemas.video import VideoOut
from ..adapters.youtube import YouTubeAdapter
from ..services.metrics import channel_metrics, like_view_ratio, comment_view_ratio
from ..services.sync import upsert_channel, upsert_video
from ..services.metrics import view_sub_ratio

router = APIRouter(prefix="/api/channels", tags=["channels"])

LONG_LIMIT = 30

def _api_key(header_key: str | None) -> str:
    key = (header_key or "").strip() or settings.youtube_api_key.strip()
    if not key:
        raise HTTPException(status_code=500, detail="YOUTUBE_API_KEY not configured (backend/.env or X-YouTube-Key)")
    return key

def _verdict(median: float | None, spike: float | None, cv: float | None, count: int) -> str:
    if median is None or count < 3 or median < settings.min_median_views:
        return "insufficient_data"
    if spike is not None and spike >= settings.spike_ratio_threshold:
        return "spike"
    if cv is not None and cv >= settings.cv_threshold:
        return "spike"
    return "stable"

@router.get("/{channel_id}", response_model=ChannelCardOut)
def get_channel_card(
    channel_id: str,
    db: Session = Depends(get_db),
    x_youtube_key: str | None = Header(default=None, alias="X-YouTube-Key"),
    force_sync: bool = False,
):
    key = _api_key(x_youtube_key)
    adapter = YouTubeAdapter(key)

    # ensure channel row exists (sync if missing or stale or forced)
    ch_row = db.get(Channel, channel_id)
    need_sync = force_sync or ch_row is None or ch_row.uploads_playlist_id is None

    if need_sync:
        try:
            ach = adapter.get_channel(channel_id)
        except Exception as e:
            msg = str(e)
            if "quotaExceeded" in msg or "quota" in msg.lower():
                raise HTTPException(status_code=429, detail=msg)
            raise HTTPException(status_code=502, detail=msg)
        if ach is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        ch_row = upsert_channel(db, ach)

    # sync videos if cache thin
    cached_videos = db.query(Video).filter(Video.channel_id == channel_id).order_by(Video.published_at.desc()).limit(LONG_LIMIT * 3).all()
    # если LONG мало — догружаем
    long_cached = [v for v in cached_videos if not v.is_shorts]
    if len(long_cached) < LONG_LIMIT or force_sync:
        try:
            fresh = adapter.get_videos(channel_id, limit=LONG_LIMIT)
            for fv in fresh:
                upsert_video(db, fv)
            # re-read
            cached_videos = db.query(Video).filter(Video.channel_id == channel_id).order_by(Video.published_at.desc()).limit(LONG_LIMIT * 3).all()
            long_cached = [v for v in cached_videos if not v.is_shorts]
        except Exception as e:
            msg = str(e)
            if "quotaExceeded" in msg or "quota" in msg.lower():
                raise HTTPException(status_code=429, detail=msg)
            # иначе отдаем что есть

    longs = [v for v in long_cached if v.view_count is not None][:LONG_LIMIT]
    # отсортировать по дате для графика (старые -> новые)
    longs_sorted = sorted(longs, key=lambda v: v.published_at or v.id)

    m = channel_metrics(longs)

    # avg вовлеченность по LONG выборке
    like_ratios = [like_view_ratio(v.like_count, v.view_count) for v in longs if v.like_count is not None and v.view_count]
    comment_ratios = [comment_view_ratio(v.comment_count, v.view_count) for v in longs if v.comment_count is not None and v.view_count]
    # фильтруем None
    like_ratios = [r for r in like_ratios if r is not None]
    comment_ratios = [r for r in comment_ratios if r is not None]
    avg_like = sum(like_ratios) / len(like_ratios) if like_ratios else None
    avg_comment = sum(comment_ratios) / len(comment_ratios) if comment_ratios else None

    verdict = _verdict(m.median_views, m.spike_ratio, m.cv, m.count)

    metrics = ChannelMetricsOut(
        count=m.count, median_views=m.median_views, mean_views=m.mean_views,
        std_views=m.std_views, cv=m.cv, spike_ratio=m.spike_ratio, consistency=m.consistency,
        max_views=m.max_views, min_views=m.min_views,
        avg_like_view=avg_like, avg_comment_view=avg_comment,
        spike_ratio_threshold=settings.spike_ratio_threshold,
        cv_threshold=settings.cv_threshold,
        min_median_views=settings.min_median_views,
        verdict=verdict,
    )

    # build VideoOut list for chart (с view_sub_ratio)
    subs = ch_row.subscriber_count
    videos_out: list[VideoOut] = []
    for v in longs_sorted:
        videos_out.append(VideoOut(
            id=v.id, title=v.title, published_at=v.published_at, duration=v.duration,
            is_shorts=v.is_shorts, view_count=v.view_count, like_count=v.like_count,
            comment_count=v.comment_count, thumbnail_url=v.thumbnail_url,
            channel_id=v.channel_id, channel_title=v.channel_title,
            channel_subscriber_count=v.channel_subscriber_count or subs,
            view_sub_ratio=view_sub_ratio(v.view_count, v.channel_subscriber_count or subs),
            like_view_ratio=like_view_ratio(v.like_count, v.view_count),
            comment_view_ratio=comment_view_ratio(v.comment_count, v.view_count),
        ))

    ch_out = ChannelOut(
        id=ch_row.id, title=ch_row.title, description=ch_row.description,
        published_at=ch_row.published_at, country=ch_row.country,
        subscriber_count=ch_row.subscriber_count, view_count=ch_row.view_count,
        video_count=ch_row.video_count, thumbnail_url=ch_row.thumbnail_url,
        uploads_playlist_id=ch_row.uploads_playlist_id, last_synced_at=ch_row.last_synced_at,
    )

    est = 1 + (1 if long_cached else 0)  # channels.list + playlistItems/videos
    return ChannelCardOut(channel=ch_out, metrics=metrics, videos=videos_out, quota_used_estimate=est)

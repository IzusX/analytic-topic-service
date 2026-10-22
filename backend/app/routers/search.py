from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timezone

from ..database import get_db
from ..config import settings
from ..models.channel import Channel, Video
from ..schemas.video import VideoOut, SearchVideosRequest, SearchVideosResponse
from ..adapters.youtube import YouTubeAdapter

router = APIRouter(prefix="/api", tags=["search"])

def _api_key(header_key: str | None) -> str:
    # Этап 1: сервисный ключ; задел под Этап 1.5 — X-YouTube-Key от пользователя
    key = (header_key or "").strip() or settings.youtube_api_key.strip()
    if not key:
        raise HTTPException(status_code=500, detail="YOUTUBE_API_KEY not configured (backend/.env or X-YouTube-Key header)")
    return key

def _adapter(x_youtube_key: str | None = Header(default=None, alias="X-YouTube-Key")):
    return YouTubeAdapter(_api_key(x_youtube_key))

def _upsert_channel(db: Session, ach) -> Channel:
    ch = db.get(Channel, ach.id)
    if ch is None:
        ch = Channel(id=ach.id)
        db.add(ch)
    ch.title = ach.title
    ch.description = ach.description or ""
    ch.published_at = ach.published_at
    ch.country = ach.country
    ch.subscriber_count = ach.subscriber_count
    ch.view_count = ach.view_count
    ch.video_count = ach.video_count
    ch.uploads_playlist_id = ach.uploads_playlist_id
    ch.thumbnail_url = ach.thumbnail_url
    ch.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(ch)
    return ch

def _upsert_video(db: Session, av, channel_subs: dict | None = None):
    v = db.get(Video, av.id)
    if v is None:
        v = Video(id=av.id, channel_id=av.channel_id or "unknown")
        db.add(v)
    # ensure channel exists as stub if needed
    cid = av.channel_id
    if cid and db.get(Channel, cid) is None and av.channel_title:
        # stub channel row so FK holds; will be enriched on next channel sync
        stub = Channel(id=cid, title=av.channel_title or "", subscriber_count=av.channel_subscriber_count)
        db.add(stub)
    v.title = av.title
    v.published_at = av.published_at
    v.duration = av.duration
    v.is_shorts = bool(av.is_shorts)
    v.thumbnail_url = av.thumbnail_url
    v.channel_title = av.channel_title
    v.channel_subscriber_count = av.channel_subscriber_count
    v.view_count = av.view_count
    v.like_count = av.like_count
    v.comment_count = av.comment_count
    if av.channel_id:
        v.channel_id = av.channel_id
    db.commit()
    return v

@router.post("/search/videos", response_model=SearchVideosResponse)
def search_videos(
    req: SearchVideosRequest,
    db: Session = Depends(get_db),
    x_youtube_key: str | None = Header(default=None, alias="X-YouTube-Key"),
):
    adapter = YouTubeAdapter(_api_key(x_youtube_key))
    try:
        avideos = adapter.search_videos(
            query=req.query,
            limit=req.limit,
            published_after=req.published_after,
            published_before=req.published_before,
            relevance_language=req.relevance_language,
        )
    except Exception as e:
        # surface quota errors cleanly
        msg = str(e)
        if "quotaExceeded" in msg or "quota" in msg.lower():
            raise HTTPException(status_code=429, detail=f"YouTube quota exceeded: {msg}")
        raise HTTPException(status_code=502, detail=f"YouTube API error: {msg}")

    # cache channels + videos
    # upsert channels for those videos
    seen_cids = set()
    for av in avideos:
        if av.channel_id and av.channel_id not in seen_cids:
            seen_cids.add(av.channel_id)
            # channel already fetched for subs inside search_videos; ensure row exists
            if db.get(Channel, av.channel_id) is None:
                # create stub then enrich via get_channel lazily is optional; we have title/subs already
                ch = Channel(id=av.channel_id, title=av.channel_title or "", subscriber_count=av.channel_subscriber_count)
                db.add(ch)
    db.commit()
    for av in avideos:
        _upsert_video(db, av)

    # build response with derived view_sub_ratio
    out: list[VideoOut] = []
    for av in avideos:
        ratio = None
        if av.view_count is not None and av.channel_subscriber_count:
            try:
                ratio = av.view_count / av.channel_subscriber_count if av.channel_subscriber_count else None
            except Exception:
                ratio = None
        out.append(VideoOut(
            id=av.id, title=av.title, published_at=av.published_at, duration=av.duration,
            is_shorts=av.is_shorts, view_count=av.view_count, like_count=av.like_count,
            comment_count=av.comment_count, thumbnail_url=av.thumbnail_url,
            channel_id=av.channel_id, channel_title=av.channel_title,
            channel_subscriber_count=av.channel_subscriber_count, view_sub_ratio=ratio,
        ))

    # quota estimate: 100 search + ~1 videos (50 ids) + ~1 channels (50 ids) — batch
    est = 100 + (1 if avideos else 0) + (1 if seen_cids else 0)
    return SearchVideosResponse(query=req.query, videos=out, quota_used_estimate=est)

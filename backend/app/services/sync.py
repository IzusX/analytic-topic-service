"""DB sync helpers — переиспользуются в search + video-card."""
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from ..models.channel import Channel, Video

def upsert_channel(db: Session, ach) -> Channel:
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

def upsert_video(db: Session, av):
    v = db.get(Video, av.id)
    if v is None:
        v = Video(id=av.id, channel_id=av.channel_id or "unknown")
        db.add(v)
    cid = av.channel_id
    if cid and db.get(Channel, cid) is None and av.channel_title:
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

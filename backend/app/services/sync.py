"""DB sync helpers — reused by search and confirmed channel sampling.

Callers commit once per successful operation, never once per video.
"""
from dataclasses import asdict
from datetime import datetime

from sqlalchemy.orm import Session

from ..models.channel import Channel, Video
from ..schemas.common import as_utc, utc_now


def upsert_channel(db: Session, ach, fetched_at: datetime | None = None) -> Channel:
    row = db.get(Channel, ach.id)
    if row is None:
        row = Channel(id=ach.id)
        db.add(row)
    for name in ("title", "description", "published_at", "country", "view_count", "video_count", "uploads_playlist_id", "thumbnail_url"):
        value = getattr(ach, name)
        if value is not None:
            setattr(row, name, as_utc(value) if name == "published_at" else value)
    if ach.subscriber_count_hidden is True:
        row.subscriber_count = None
    elif ach.subscriber_count is not None:
        row.subscriber_count = ach.subscriber_count
    if ach.subscriber_count_hidden is not None:
        row.subscriber_count_hidden = ach.subscriber_count_hidden
    row.last_synced_at = fetched_at or utc_now()
    row.updated_at = row.last_synced_at
    db.flush()
    return row


def upsert_video(db: Session, av, fetched_at: datetime | None = None) -> Video | None:
    if not av.channel_id:
        # An incomplete source row is returned to the caller, not given a fabricated channel FK.
        return None
    channel = db.get(Channel, av.channel_id)
    if channel is None:
        channel = Channel(id=av.channel_id, title=av.channel_title or "")
        db.add(channel)
    if av.channel_subscriber_count_hidden is True:
        channel.subscriber_count = None
    elif av.channel_subscriber_count is not None:
        channel.subscriber_count = av.channel_subscriber_count
    if av.channel_subscriber_count_hidden is not None:
        channel.subscriber_count_hidden = av.channel_subscriber_count_hidden
    db.flush()

    row = db.get(Video, av.id)
    if row is None:
        row = Video(id=av.id, channel_id=av.channel_id)
        db.add(row)
    row.channel_id = av.channel_id
    for name in ("title", "published_at", "duration", "duration_seconds", "thumbnail_url", "channel_title", "view_count", "like_count", "comment_count"):
        value = getattr(av, name)
        if value is not None:
            setattr(row, name, as_utc(value) if name == "published_at" else value)
    if av.channel_subscriber_count_hidden is True:
        row.channel_subscriber_count = None
    elif av.channel_subscriber_count is not None:
        row.channel_subscriber_count = av.channel_subscriber_count
    if av.channel_subscriber_count_hidden is not None:
        row.channel_subscriber_count_hidden = av.channel_subscriber_count_hidden
    row.fetched_at = fetched_at or utc_now()
    payload = asdict(av)
    payload["published_at"] = as_utc(av.published_at).isoformat() if av.published_at else None
    row.source_payload = payload
    db.flush()
    return row

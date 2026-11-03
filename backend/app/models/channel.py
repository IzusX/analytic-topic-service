from datetime import datetime, timezone
from sqlalchemy import String, Integer, BigInteger, DateTime, ForeignKey, Boolean, JSON, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # YouTube channelId (UC...)
    title: Mapped[str] = mapped_column(String(512), default="")
    description: Mapped[str] = mapped_column(String(4096), default="")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    country: Mapped[str | None] = mapped_column(String(8), nullable=True)

    subscriber_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    subscriber_count_hidden: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    view_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    video_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    uploads_playlist_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    videos: Mapped[list["Video"]] = relationship(back_populates="channel", cascade="all, delete-orphan")
    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="channel", cascade="all, delete-orphan")


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # YouTube videoId
    channel_id: Mapped[str] = mapped_column(String(64), ForeignKey("channels.id", ondelete="CASCADE"), index=True)

    title: Mapped[str] = mapped_column(String(512), default="")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    duration: Mapped[str | None] = mapped_column(String(32), nullable=True)  # ISO 8601 PT...
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # denormalized for fast video-card without JOIN — updated on sync
    channel_title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    channel_subscriber_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    channel_subscriber_count_hidden: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    view_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    like_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    comment_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Coherent source snapshot: an incomplete newer response does not relabel old counts as fresh.
    source_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    channel: Mapped["Channel"] = relationship(back_populates="videos")

    __table_args__ = (
        Index("ix_videos_channel_published", "channel_id", "published_at"),
    )


class Snapshot(Base):
    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[str] = mapped_column(String(64), ForeignKey("channels.id", ondelete="CASCADE"), index=True)
    date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    subscriber_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    view_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    channel: Mapped["Channel"] = relationship(back_populates="snapshots")

    __table_args__ = (
        Index("ix_snapshots_channel_date", "channel_id", "date"),
    )


class ChannelAnalysis(Base):
    """A confirmed uploads sample; search rows never stand in for this payload."""
    __tablename__ = "channel_analyses"

    channel_id: Mapped[str] = mapped_column(String(64), ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True)
    sample_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSON)

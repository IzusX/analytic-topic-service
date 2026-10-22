from __future__ import annotations
import re
from datetime import datetime, timezone
from dateutil.parser import isoparse

from .base import DataSourceAdapter, AdapterChannel, AdapterVideo

_ISO_RE = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")

def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = isoparse(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None

def _int(v) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except Exception:
        return None

def _thumb(snippet: dict) -> str | None:
    thumbs = snippet.get("thumbnails") or {}
    for k in ("high", "medium", "default"):
        if k in thumbs and thumbs[k].get("url"):
            return thumbs[k]["url"]
    return None

def _duration_seconds(iso: str | None) -> int | None:
    if not iso:
        return None
    m = _ISO_RE.match(iso)
    if not m:
        return None
    h, mm, s = m.groups()
    return (int(h or 0) * 3600) + (int(mm or 0) * 60) + int(s or 0)

def _is_shorts(duration: str | None) -> bool:
    sec = _duration_seconds(duration)
    if sec is None:
        return False
    return sec <= 60


class YouTubeAdapter(DataSourceAdapter):
    """
    Public-data mode: только публичные поля через YouTube Data API v3 по API-ключу.
    Квота: search.list=100, channels.list=1, videos.list=1, playlistItems=1.
    Поддерживает 2 режима ключа: сервисный (backend/.env) и пользовательский (X-YouTube-Key) — ключ передается в конструктор.
    """

    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY is empty — set it in backend/.env or pass X-YouTube-Key")
        from googleapiclient.discovery import build
        self._service = build("youtube", "v3", developerKey=api_key, cache_discovery=False)

    # --- DataSourceAdapter impl ---

    def search_channels(self, query: str, limit: int = 20) -> list[AdapterChannel]:
        resp = self._service.search().list(
            part="snippet", q=query, type="channel", maxResults=min(limit, 50)
        ).execute()
        channel_ids: list[str] = []
        for item in resp.get("items", []):
            cid = item.get("snippet", {}).get("channelId") or item.get("id", {}).get("channelId")
            if cid:
                channel_ids.append(cid)
        if not channel_ids:
            return []
        return self._get_channels_by_ids(channel_ids)

    def get_channel(self, channel_id: str) -> AdapterChannel | None:
        res = self._get_channels_by_ids([channel_id])
        return res[0] if res else None

    def get_videos(self, channel_id: str, limit: int = 50) -> list[AdapterVideo]:
        ch = self.get_channel(channel_id)
        if not ch or not ch.uploads_playlist_id:
            return []
        return self._get_videos_by_playlist(ch.uploads_playlist_id, limit)

    def search_videos(
        self,
        query: str,
        limit: int = 20,
        published_after: datetime | None = None,
        published_before: datetime | None = None,
        relevance_language: str | None = None,
    ) -> list[AdapterVideo]:
        kwargs: dict = dict(part="snippet", q=query, type="video", maxResults=min(limit, 50))
        if published_after:
            # YouTube expects RFC3339
            kwargs["publishedAfter"] = published_after.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if published_before:
            kwargs["publishedBefore"] = published_before.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if relevance_language:
            kwargs["relevanceLanguage"] = relevance_language
        resp = self._service.search().list(**kwargs).execute()
        video_ids: list[str] = []
        # search snippet already has channelId/title, keep for fallback
        snippet_by_id: dict[str, dict] = {}
        for item in resp.get("items", []):
            vid = item.get("id", {}).get("videoId")
            if vid:
                video_ids.append(vid)
                snippet_by_id[vid] = item.get("snippet", {})
        if not video_ids:
            return []
        videos = self._get_videos_by_ids(video_ids)
        # enrich with channel subscriber counts (batch)
        channel_ids = list({v.channel_id for v in videos if v.channel_id})
        subs_by_channel: dict[str, int | None] = {}
        title_by_channel: dict[str, str] = {}
        if channel_ids:
            # reuse _get_channels_by_ids via adapter but we already have service; just call channels.list
            for ch in self._get_channels_by_ids(channel_ids):
                subs_by_channel[ch.id] = ch.subscriber_count
                title_by_channel[ch.id] = ch.title
        for v in videos:
            if v.channel_id:
                v.channel_subscriber_count = subs_by_channel.get(v.channel_id)
                if not v.channel_title:
                    v.channel_title = title_by_channel.get(v.channel_id)
        return videos

    # --- internals ---

    def _get_channels_by_ids(self, ids: list[str]) -> list[AdapterChannel]:
        if not ids:
            return []
        out: list[AdapterChannel] = []
        for i in range(0, len(ids), 50):
            batch = ids[i:i+50]
            resp = self._service.channels().list(
                part="snippet,statistics,contentDetails", id=",".join(batch)
            ).execute()
            for item in resp.get("items", []):
                snippet = item.get("snippet", {})
                stats = item.get("statistics", {})
                details = item.get("contentDetails", {})
                uploads = (details.get("relatedPlaylists") or {}).get("uploads")
                out.append(AdapterChannel(
                    id=item["id"],
                    title=snippet.get("title", ""),
                    description=snippet.get("description", ""),
                    published_at=_parse_dt(snippet.get("publishedAt")),
                    country=snippet.get("country"),
                    subscriber_count=_int(stats.get("subscriberCount")),
                    view_count=_int(stats.get("viewCount")),
                    video_count=_int(stats.get("videoCount")),
                    uploads_playlist_id=uploads,
                    thumbnail_url=_thumb(snippet),
                ))
        return out

    def _get_videos_by_playlist(self, playlist_id: str, limit: int) -> list[AdapterVideo]:
        video_ids: list[str] = []
        page_token = None
        while len(video_ids) < limit:
            resp = self._service.playlistItems().list(
                part="contentDetails", playlistId=playlist_id,
                maxResults=min(50, limit - len(video_ids)), pageToken=page_token
            ).execute()
            for item in resp.get("items", []):
                vid = item.get("contentDetails", {}).get("videoId")
                if vid:
                    video_ids.append(vid)
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
        if not video_ids:
            return []
        return self._get_videos_by_ids(video_ids[:limit])

    def _get_videos_by_ids(self, ids: list[str]) -> list[AdapterVideo]:
        out: list[AdapterVideo] = []
        for i in range(0, len(ids), 50):
            batch = ids[i:i+50]
            resp = self._service.videos().list(
                part="snippet,statistics,contentDetails", id=",".join(batch)
            ).execute()
            for item in resp.get("items", []):
                snippet = item.get("snippet", {})
                stats = item.get("statistics", {})
                details = item.get("contentDetails", {})
                dur = details.get("duration")
                out.append(AdapterVideo(
                    id=item["id"],
                    title=snippet.get("title", ""),
                    published_at=_parse_dt(snippet.get("publishedAt")),
                    duration=dur,
                    is_shorts=_is_shorts(dur),
                    view_count=_int(stats.get("viewCount")),
                    like_count=_int(stats.get("likeCount")),
                    comment_count=_int(stats.get("commentCount")),
                    thumbnail_url=_thumb(snippet),
                    channel_id=snippet.get("channelId"),
                    channel_title=snippet.get("channelTitle"),
                ))
        return out

from __future__ import annotations
import re
from datetime import datetime, timezone
from dateutil.parser import isoparse

from .base import DataSourceAdapter, AdapterChannel, AdapterVideo, AdapterVideoPage

_ISO_RE = re.compile(
    r"P(?:([0-9]+)D)?(?:T(?=[0-9])(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?"
)

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
    m = _ISO_RE.fullmatch(iso)
    if not m or not any(value is not None for value in m.groups()):
        return None
    d, h, mm, s = m.groups()
    return (int(d or 0) * 86400) + (int(h or 0) * 3600) + (int(mm or 0) * 60) + int(s or 0)


class YouTubeAdapter(DataSourceAdapter):
    """
    Public-data mode: только публичные поля через YouTube Data API v3 по API-ключу.
    Квота: search.list=100, channels.list=1, videos.list=1, playlistItems=1.
    Ключ передаётся в конструктор. API использует сервисный режим; пользовательский X-YouTube-Key пока отложен.
    """

    def __init__(self, api_key: str, service=None):
        super().__init__()
        if service is not None:
            self._service = service
            return
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY is empty — configure the service key on the server")
        from googleapiclient.discovery import build
        from googleapiclient.http import build_http
        http = build_http()
        http.timeout = 15
        # Discovery already supplies youtube/v3 paths; use Google's shared API root.
        self._service = build(
            "youtube", "v3", developerKey=api_key, http=http,
            client_options={"api_endpoint": "https://www.googleapis.com/"},
            cache_discovery=False, static_discovery=True,
        )

    # --- DataSourceAdapter impl ---

    def search_channels(self, query: str, limit: int = 20) -> list[AdapterChannel]:
        resp = self._execute(self._service.search().list(
            part="snippet", q=query, type="channel", maxResults=min(limit, 50)
        ), cost=100)
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

    def get_video(self, video_id: str) -> AdapterVideo | None:
        res = self._get_videos_by_ids([video_id])
        if not res:
            return None
        v = res[0]
        # enrich subs for single card
        if v.channel_id:
            ch = self.get_channel(v.channel_id)
            if ch:
                v.channel_subscriber_count = ch.subscriber_count
                v.channel_subscriber_count_hidden = ch.subscriber_count_hidden
                if not v.channel_title:
                    v.channel_title = ch.title
        return v

    def get_videos(self, channel_id: str, limit: int = 50) -> list[AdapterVideo]:
        ch = self.get_channel(channel_id)
        if not ch or not ch.uploads_playlist_id:
            return []
        return self._get_videos_by_playlist(ch.uploads_playlist_id, limit)

    def get_uploads_page(
        self, playlist_id: str, page_token: str | None = None, limit: int = 50
    ) -> AdapterVideoPage:
        kwargs: dict = dict(
            part="contentDetails", playlistId=playlist_id, maxResults=min(limit, 50)
        )
        if page_token:
            kwargs["pageToken"] = page_token
        resp = self._execute(self._service.playlistItems().list(**kwargs))
        items = resp.get("items", [])
        video_ids = [
            item["contentDetails"]["videoId"]
            for item in items if item.get("contentDetails", {}).get("videoId")
        ]
        return AdapterVideoPage(
            videos=self._get_videos_by_ids(video_ids),
            next_page_token=resp.get("nextPageToken"),
            items_scanned=len(items),
        )

    def search_videos(
        self,
        query: str = "",
        limit: int = 50,
        published_after: datetime | None = None,
        published_before: datetime | None = None,
        relevance_language: str | None = None,
        page_token: str | None = None,
    ) -> AdapterVideoPage:
        kwargs: dict = dict(part="snippet", type="video", maxResults=min(limit, 50), order="relevance")
        query = query.strip()
        if query:
            kwargs["q"] = query
        if published_after:
            # YouTube expects RFC3339
            kwargs["publishedAfter"] = published_after.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if published_before:
            kwargs["publishedBefore"] = published_before.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if relevance_language:
            kwargs["relevanceLanguage"] = relevance_language
        if page_token:
            kwargs["pageToken"] = page_token
        resp = self._execute(self._service.search().list(**kwargs), cost=100)
        items = resp.get("items", [])
        video_ids: list[str] = []
        # search snippet already has channelId/title, keep for fallback
        snippet_by_id: dict[str, dict] = {}
        for item in items:
            vid = item.get("id", {}).get("videoId")
            if vid:
                video_ids.append(vid)
                snippet_by_id[vid] = item.get("snippet", {})
        videos = self._get_videos_by_ids(video_ids)
        for v in videos:
            snippet = snippet_by_id.get(v.id, {})
            if not v.channel_id:
                v.channel_id = snippet.get("channelId")
            if not v.channel_title:
                v.channel_title = snippet.get("channelTitle")
        # enrich with channel subscriber counts (batch)
        channel_ids = list(dict.fromkeys(v.channel_id for v in videos if v.channel_id))
        channels: list[AdapterChannel] = []
        if channel_ids:
            # reuse _get_channels_by_ids via adapter but we already have service; just call channels.list
            channels = self._get_channels_by_ids(channel_ids)
        channels_by_id = {ch.id: ch for ch in channels}
        for v in videos:
            ch = channels_by_id.get(v.channel_id)
            if ch:
                v.channel_subscriber_count = ch.subscriber_count
                v.channel_subscriber_count_hidden = ch.subscriber_count_hidden
                if not v.channel_title:
                    v.channel_title = ch.title
        return AdapterVideoPage(
            videos=videos,
            next_page_token=resp.get("nextPageToken"),
            items_scanned=len(items),
            channels=channels,
        )

    # --- internals ---

    def _execute(self, request, cost: int = 1) -> dict:
        self.quota_used_estimate += cost
        return request.execute()

    def _get_channels_by_ids(self, ids: list[str]) -> list[AdapterChannel]:
        if not ids:
            return []
        channels_by_id: dict[str, AdapterChannel] = {}
        for i in range(0, len(ids), 50):
            batch = ids[i:i+50]
            resp = self._execute(self._service.channels().list(
                part="snippet,statistics,contentDetails", id=",".join(batch)
            ))
            for item in resp.get("items", []):
                snippet = item.get("snippet", {})
                stats = item.get("statistics", {})
                details = item.get("contentDetails", {})
                uploads = (details.get("relatedPlaylists") or {}).get("uploads")
                hidden = stats.get("hiddenSubscriberCount")
                if not isinstance(hidden, bool):
                    hidden = None
                channels_by_id[item["id"]] = AdapterChannel(
                    id=item["id"],
                    title=snippet.get("title", ""),
                    description=snippet.get("description", ""),
                    published_at=_parse_dt(snippet.get("publishedAt")),
                    country=snippet.get("country"),
                    subscriber_count=None if hidden is True else _int(stats.get("subscriberCount")),
                    view_count=_int(stats.get("viewCount")),
                    video_count=_int(stats.get("videoCount")),
                    uploads_playlist_id=uploads,
                    thumbnail_url=_thumb(snippet),
                    subscriber_count_hidden=hidden,
                )
        return [channels_by_id[cid] for cid in ids if cid in channels_by_id]

    def _get_videos_by_playlist(self, playlist_id: str, limit: int) -> list[AdapterVideo]:
        limit = max(0, min(limit, 200))
        videos: list[AdapterVideo] = []
        page_token = None
        items_scanned = 0
        for _ in range((limit + 49) // 50):
            page = self.get_uploads_page(
                playlist_id, page_token=page_token, limit=min(50, limit - items_scanned)
            )
            videos.extend(page.videos)
            items_scanned += page.items_scanned
            page_token = page.next_page_token
            if items_scanned >= limit or not page_token:
                break
        return videos[:limit]

    def _get_videos_by_ids(self, ids: list[str]) -> list[AdapterVideo]:
        videos_by_id: dict[str, AdapterVideo] = {}
        for i in range(0, len(ids), 50):
            batch = ids[i:i+50]
            resp = self._execute(self._service.videos().list(
                part="snippet,statistics,contentDetails", id=",".join(batch)
            ))
            for item in resp.get("items", []):
                snippet = item.get("snippet", {})
                stats = item.get("statistics", {})
                details = item.get("contentDetails", {})
                dur = details.get("duration")
                videos_by_id[item["id"]] = AdapterVideo(
                    id=item["id"],
                    title=snippet.get("title", ""),
                    published_at=_parse_dt(snippet.get("publishedAt")),
                    duration=dur,
                    duration_seconds=_duration_seconds(dur),
                    view_count=_int(stats.get("viewCount")),
                    like_count=_int(stats.get("likeCount")),
                    comment_count=_int(stats.get("commentCount")),
                    thumbnail_url=_thumb(snippet),
                    channel_id=snippet.get("channelId"),
                    channel_title=snippet.get("channelTitle"),
                )
        return [videos_by_id[vid] for vid in ids if vid in videos_by_id]

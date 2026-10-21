from __future__ import annotations
from datetime import datetime
from dateutil.parser import isoparse
import time

from .base import DataSourceAdapter, AdapterChannel, AdapterVideo

def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return isoparse(s)
    except Exception:
        return None

def _int(v) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except Exception:
        return None


class YouTubeAdapter(DataSourceAdapter):
    """
    Public-data mode: только публичные поля через YouTube Data API v3 по API-ключу.
    Квота: search.list=100, channels.list=1, videos.list=1, playlistItems=1.
    """

    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY is empty — set it in backend/.env")
        # Lazy import so app can start without the package for scaffolding
        from googleapiclient.discovery import build
        self._service = build("youtube", "v3", developerKey=api_key, cache_discovery=False)

    # --- public interface ---

    def search_channels(self, query: str, limit: int = 20) -> list[AdapterChannel]:
        # search.list type=channel
        resp = self._service.search().list(
            part="snippet", q=query, type="channel", maxResults=min(limit, 50)
        ).execute()
        channel_ids = [item["snippet"]["channelId"] for item in resp.get("items", []) if "channelId" in item["snippet"]]
        # Fallback: some responses put channelId in id.channelId
        if not channel_ids:
            channel_ids = [item["id"]["channelId"] for item in resp.get("items", []) if item.get("id", {}).get("channelId")]
        if not channel_ids:
            return []
        return self._get_channels_by_ids(channel_ids)

    def get_channel(self, channel_id: str) -> AdapterChannel | None:
        res = self._get_channels_by_ids([channel_id])
        return res[0] if res else None

    def get_videos(self, channel_id: str, limit: int = 50) -> list[AdapterVideo]:
        # Need uploads playlist id
        ch = self.get_channel(channel_id)
        if not ch or not ch.uploads_playlist_id:
            return []
        return self._get_videos_by_playlist(ch.uploads_playlist_id, limit)

    # --- internals ---

    def _get_channels_by_ids(self, ids: list[str]) -> list[AdapterChannel]:
        if not ids:
            return []
        # batch 50
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
                ))
        return out

    def _get_videos_by_playlist(self, playlist_id: str, limit: int) -> list[AdapterVideo]:
        # Collect videoIds via playlistItems
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
                out.append(AdapterVideo(
                    id=item["id"],
                    title=snippet.get("title", ""),
                    published_at=_parse_dt(snippet.get("publishedAt")),
                    duration=details.get("duration"),
                    view_count=_int(stats.get("viewCount")),
                    like_count=_int(stats.get("likeCount")),
                    comment_count=_int(stats.get("commentCount")),
                ))
        return out

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime

@dataclass
class AdapterChannel:
    id: str
    title: str
    description: str
    published_at: datetime | None
    country: str | None
    subscriber_count: int | None
    view_count: int | None
    video_count: int | None
    uploads_playlist_id: str | None

@dataclass
class AdapterVideo:
    id: str
    title: str
    published_at: datetime | None
    duration: str | None
    view_count: int | None
    like_count: int | None
    comment_count: int | None


class DataSourceAdapter(ABC):
    """Расширяемость: YouTubeAdapter — первая реализация; TikTok/VK подключаются заменой адаптера."""

    @abstractmethod
    def search_channels(self, query: str, limit: int = 20) -> list[AdapterChannel]:
        ...

    @abstractmethod
    def get_channel(self, channel_id: str) -> AdapterChannel | None:
        ...

    @abstractmethod
    def get_videos(self, channel_id: str, limit: int = 50) -> list[AdapterVideo]:
        ...

    # Комбинированный хелпер для MVP — не обязателен, но удобен для /api/search
    def search_with_videos(self, query: str, limit: int = 20, videos_per_channel: int = 30):
        channels = self.search_channels(query, limit)
        result = []
        for ch in channels:
            vids = self.get_videos(ch.id, videos_per_channel)
            result.append((ch, vids))
        return result

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
    thumbnail_url: str | None = None

@dataclass
class AdapterVideo:
    id: str
    title: str
    published_at: datetime | None
    duration: str | None               # ISO8601 e.g. PT5M33S
    is_shorts: bool = False
    view_count: int | None = None
    like_count: int | None = None
    comment_count: int | None = None
    thumbnail_url: str | None = None
    channel_id: str | None = None
    channel_title: str | None = None
    channel_subscriber_count: int | None = None


class DataSourceAdapter(ABC):
    """Расширяемость: YouTubeAdapter — первая реализация; TikTok/VK подключаются заменой адаптера.
    Поддерживает 2 режима ключа: сервисный (backend/.env) и пользовательский (X-YouTube-Key) — задел под Этап 1.5.
    """

    @abstractmethod
    def search_channels(self, query: str, limit: int = 20) -> list[AdapterChannel]:
        ...

    @abstractmethod
    def get_channel(self, channel_id: str) -> AdapterChannel | None:
        ...

    @abstractmethod
    def get_videos(self, channel_id: str, limit: int = 50) -> list[AdapterVideo]:
        ...

    # --- Новые методы для флоу "поиск видео -> карточка видео -> аналитика канала" ---

    @abstractmethod
    def search_videos(
        self,
        query: str,
        limit: int = 20,
        published_after: datetime | None = None,
        published_before: datetime | None = None,
        relevance_language: str | None = None,
    ) -> list[AdapterVideo]:
        """Поиск видео по ключу; обогащает через videos.list+channels.list."""
        ...

    @abstractmethod
    def get_video(self, video_id: str) -> AdapterVideo | None:
        """Одна карточка видео (videos.list id=...)."""
        ...

    # Комбинированный хелпер
    def search_with_videos(self, query: str, limit: int = 20, videos_per_channel: int = 30):
        channels = self.search_channels(query, limit)
        result = []
        for ch in channels:
            vids = self.get_videos(ch.id, videos_per_channel)
            result.append((ch, vids))
        return result

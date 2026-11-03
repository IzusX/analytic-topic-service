from abc import ABC, abstractmethod
from dataclasses import dataclass, field
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
    subscriber_count_hidden: bool | None = None

@dataclass
class AdapterVideo:
    id: str
    title: str
    published_at: datetime | None
    duration: str | None               # ISO8601 e.g. PT5M33S
    duration_seconds: int | None = None
    view_count: int | None = None
    like_count: int | None = None
    comment_count: int | None = None
    thumbnail_url: str | None = None
    channel_id: str | None = None
    channel_title: str | None = None
    channel_subscriber_count: int | None = None
    channel_subscriber_count_hidden: bool | None = None


@dataclass
class AdapterVideoPage:
    videos: list[AdapterVideo]
    next_page_token: str | None = None
    items_scanned: int = 0
    channels: list[AdapterChannel] = field(default_factory=list)


class DataSourceAdapter(ABC):
    """Расширяемость: YouTubeAdapter — первая реализация; TikTok/VK подключаются заменой адаптера.
    API сейчас использует сервисный ключ (backend/.env). Пользовательский режим X-YouTube-Key отложен до отдельного этапа.
    """

    def __init__(self):
        self.quota_used_estimate: int = 0

    @abstractmethod
    def search_channels(self, query: str, limit: int = 20) -> list[AdapterChannel]:
        ...

    @abstractmethod
    def get_channel(self, channel_id: str) -> AdapterChannel | None:
        ...

    @abstractmethod
    def get_videos(self, channel_id: str, limit: int = 50) -> list[AdapterVideo]:
        ...

    @abstractmethod
    def get_uploads_page(
        self, playlist_id: str, page_token: str | None = None, limit: int = 50
    ) -> AdapterVideoPage:
        """Одна страница загрузок; обогащает через videos.list без фильтрации."""
        ...

    # --- Новые методы для флоу "поиск видео -> карточка видео -> аналитика канала" ---

    @abstractmethod
    def search_videos(
        self,
        query: str = "",
        limit: int = 50,
        published_after: datetime | None = None,
        published_before: datetime | None = None,
        relevance_language: str | None = None,
        page_token: str | None = None,
    ) -> AdapterVideoPage:
        """Одна страница поиска видео; обогащает через videos.list+channels.list."""
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

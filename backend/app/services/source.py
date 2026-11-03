"""One source factory and safe error mapping for every API route."""
from collections.abc import Callable
import json

from fastapi import HTTPException
from googleapiclient.errors import HttpError

from ..adapters.base import DataSourceAdapter
from ..adapters.youtube import YouTubeAdapter
from ..config import settings

AdapterFactory = Callable[[], DataSourceAdapter]


def api_error(status: int, code: str, message: str, retryable: bool = False) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, "retryable": retryable})


def source_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HttpError):
        status = int(exc.resp.status)
        try:
            content = json.loads(exc.content)
            reasons = {item.get("reason") for item in content.get("error", {}).get("errors", [])}
        except (ValueError, TypeError, AttributeError):
            reasons = set()
        if reasons & {"quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg"}:
            return api_error(429, "quota_exceeded", "Квота YouTube исчерпана. Повторите позже.")
        if status == 429 or reasons & {"rateLimitExceeded", "userRateLimitExceeded"}:
            return api_error(429, "source_rate_limited", "YouTube ограничил частоту запросов. Повторите позже.", True)
        if status == 400 and not reasons & {"keyInvalid"}:
            return api_error(400, "source_invalid_request", "YouTube не принял параметры запроса. Проверьте условия поиска.")
        if status == 404:
            return api_error(404, "source_not_found", "Запрошенные данные YouTube недоступны.")
    # Never copy exception strings: HttpError contains request URLs and may contain the API key.
    return api_error(502, "source_unavailable", "Не удалось получить данные YouTube. Ранее полученные данные сохранены.", True)


def source_call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except HTTPException:
        raise
    except Exception as exc:
        raise source_error(exc) from None


def create_adapter() -> DataSourceAdapter:
    key = settings.youtube_api_key.get_secret_value().strip()
    if not key:
        raise api_error(503, "source_not_configured", "Источник YouTube не настроен на сервере.")
    return source_call(YouTubeAdapter, key)


def get_adapter_factory() -> AdapterFactory:
    # Lazy creation lets a confirmed cache hit work without initializing the SDK or checking a key.
    return create_adapter

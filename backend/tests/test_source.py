import json

import httplib2
from googleapiclient.errors import HttpError
from pydantic import SecretStr
import pytest

from app.adapters.youtube import YouTubeAdapter
from app.config import settings
from app.main import app
from app.services.source import get_adapter_factory, source_error
from app.schemas.error import ApiErrorResponse


@pytest.mark.parametrize("status,reason,expected,code", [
    (403, "quotaExceeded", 429, "quota_exceeded"),
    (403, "dailyLimitExceeded", 429, "quota_exceeded"),
    (429, "rateLimitExceeded", 429, "source_rate_limited"),
    (400, "invalidPageToken", 400, "source_invalid_request"),
    (404, "notFound", 404, "source_not_found"),
    (500, "backendError", 502, "source_unavailable"),
])
def test_source_errors_are_structured_without_raw_content(status, reason, expected, code):
    raw = {"error": {"message": "PRIVATE_EXAMPLE_TOKEN", "errors": [{"reason": reason}]}}
    error = HttpError(httplib2.Response({"status": str(status)}), json.dumps(raw).encode(), uri="https://example.invalid?key=PRIVATE_EXAMPLE_TOKEN")
    mapped = source_error(error)
    assert mapped.status_code == expected
    assert mapped.detail["code"] == code
    assert "PRIVATE_EXAMPLE_TOKEN" not in json.dumps(mapped.detail)
    ApiErrorResponse.model_validate({"detail": mapped.detail})


def test_runtime_exception_not_echoed():
    error = source_error(RuntimeError("PRIVATE_EXAMPLE_TOKEN stack URL"))
    assert error.status_code == 502
    assert "PRIVATE_EXAMPLE_TOKEN" not in error.detail["message"]


def test_missing_service_key_cannot_be_replaced_by_deferred_header(client, monkeypatch):
    monkeypatch.setattr(settings, "youtube_api_key", SecretStr(""))
    app.dependency_overrides.pop(get_adapter_factory)
    response = client.post("/api/search/videos", json={}, headers={"X-YouTube-Key": "PRIVATE_EXAMPLE_TOKEN"})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "source_not_configured"
    assert "PRIVATE_EXAMPLE_TOKEN" not in response.text


def test_sdk_can_construct_textless_request_without_network():
    # The real SDK uses its bundled discovery description, not a fake HTTP resource.
    adapter = YouTubeAdapter("local-test-placeholder")
    request = adapter._service.search().list(part="snippet", type="video", order="relevance", maxResults=50, relevanceLanguage="zh-Hant")
    assert "q=" not in request.uri
    assert "order=relevance" in request.uri
    assert "relevanceLanguage=zh-Hant" in request.uri
    assert "regionCode" not in request.uri
    assert adapter.quota_used_estimate == 0

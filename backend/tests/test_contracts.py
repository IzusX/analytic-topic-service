import json
from pathlib import Path

from app.export_contracts import typescript_contract
from app.main import app

CONTRACTS = Path(__file__).resolve().parents[1] / "contracts"


def test_generated_openapi_matches_current_api():
    document = json.loads((CONTRACTS / "openapi.json").read_text(encoding="utf-8"))
    assert document == app.openapi()


def test_typescript_is_generated_from_same_schema_not_a_separate_contract():
    document = app.openapi()
    assert (CONTRACTS / "api.ts").read_text(encoding="utf-8") == typescript_contract(document)
    models = document["components"]["schemas"]
    for name in ("VideoOut", "VideoCardOut", "ChannelMetricsOut"):
        assert "is_shorts" not in models[name]["properties"]
        assert "verdict" not in models[name]["properties"]
        assert "is_anomaly" not in models[name]["properties"]
    assert "duration_seconds" in models["VideoOut"]["properties"]
    assert "next_page_token" in models["SearchVideosResponse"]["properties"]
    assert "sample" in models["ChannelCardOut"]["properties"]


def test_openapi_errors_and_deferred_key_mode():
    document = app.openapi()
    assert document["paths"]["/api/search/videos"]["post"]["responses"]["422"]["content"]["application/json"]["schema"]["$ref"].endswith("ApiErrorResponse")
    assert "X-YouTube-Key" not in json.dumps(document)
    assert "/settings" not in document["paths"]

from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    youtube_api_key: SecretStr = SecretStr("")
    database_url: str = f"sqlite:///{BACKEND_DIR / 'app.db'}"

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",  # Legacy threshold settings do not change descriptive metrics.
    )


settings = Settings()

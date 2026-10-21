from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    youtube_api_key: str = ""
    database_url: str = "sqlite:///./app.db"

    # MVP thresholds — tunable without code change
    spike_ratio_threshold: float = 5.0
    cv_threshold: float = 1.0
    min_median_views: int = 1000
    min_uploads_per_week: float = 2.0

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

settings = Settings()

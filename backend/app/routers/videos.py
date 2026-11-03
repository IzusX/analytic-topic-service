"""Optional direct video endpoint. Short videos are never compared to the >180s sample."""
from typing import Annotated

from fastapi import APIRouter, Depends, Path
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.channel import Video
from ..schemas.common import as_utc, utc_now
from ..schemas.video import VideoCardOut, VideoOut
from ..services.analysis import load_channel_analysis
from ..services.presentation import video_out
from ..services.source import AdapterFactory, api_error, get_adapter_factory, source_call
from ..services.sync import upsert_video

router = APIRouter(prefix="/api/videos", tags=["videos"])


@router.get("/{video_id}", response_model=VideoCardOut)
def get_video_card(
    video_id: Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")],
    db: Session = Depends(get_db),
    factory: AdapterFactory = Depends(get_adapter_factory),
    force_sync: bool = False,
):
    cached = db.get(Video, video_id)
    adapter = None
    video = None
    if cached is not None and cached.source_payload and cached.fetched_at and not force_sync:
        try:
            video = video_out(VideoOut.model_validate(cached.source_payload))
        except ValidationError:
            pass
    from_cache = video is not None
    fetched_at = as_utc(cached.fetched_at) if from_cache else utc_now()
    initial_quota = 0
    if video is None:
        adapter = factory()
        initial_quota = adapter.quota_used_estimate
        fresh = source_call(adapter.get_video, video_id)
        if fresh is None:
            raise api_error(404, "video_not_found", "Видео не найдено или недоступно.")
        fetched_at = utc_now()
        video = video_out(fresh)
        upsert_video(db, fresh, fetched_at)

    status, reason = "unavailable", "Канал видео неизвестен; сравнение с выборкой не рассчитано."
    sample = None
    sample_fetched_at = None
    median = None
    if video.duration_seconds is None:
        status, reason = "duration_unknown", "Длительность видео неизвестна; оно не сравнивается с выборкой более 3 минут."
    elif video.duration_seconds <= 180:
        status, reason = "duration_too_short", "Видео длится не более 3 минут и не сравнивается с этой выборкой."
    elif video.channel_id:
        analysis = load_channel_analysis(db, video.channel_id, (lambda: adapter) if adapter is not None else factory, force_sync)
        sample = analysis.sample
        sample_fetched_at = analysis.fetched_at
        median = analysis.metrics.median_views
        # A selected video and its median are returned from the same coherent snapshot.
        member = next((item for item in analysis.videos if item.id == video.id), None)
        from_cache = from_cache and analysis.from_cache
        if member is not None:
            video = member.model_copy()
            fetched_at = analysis.fetched_at
            status = "included"
            reason = None if median not in (None, 0) else "Медиана неизвестна или равна нулю; отношение к ней не определено."
        else:
            status, reason = "not_in_sample", "Видео не входит в полученную выборку; отношение к её медиане не рассчитывается."
    db.commit()
    return VideoCardOut(
        **video.model_dump(), channel_median_views=median,
        channel_sample_count=sample.metric_count if sample is not None else None, sample=sample,
        comparison_status=status, comparison_reason=reason, fetched_at=fetched_at,
        sample_fetched_at=sample_fetched_at, from_cache=from_cache,
        quota_used_estimate=(adapter.quota_used_estimate - initial_quota) if adapter is not None else (0 if sample is None else analysis.quota_used_estimate),
    )

from fastapi import APIRouter, Depends
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas.common import utc_now
from ..schemas.video import SearchVideosRequest, SearchVideosResponse
from ..services.presentation import video_out
from ..services.search import freeze_search, matches_filters
from ..services.source import AdapterFactory, api_error, get_adapter_factory, source_call
from ..services.sync import upsert_channel, upsert_video

router = APIRouter(prefix="/api", tags=["search"])


@router.post("/search/videos", response_model=SearchVideosResponse)
def search_videos(
    req: SearchVideosRequest,
    db: Session = Depends(get_db),
    factory: AdapterFactory = Depends(get_adapter_factory),
):
    try:
        applied = freeze_search(req, utc_now())
    except ValidationError:
        raise api_error(422, "invalid_search_dates", "Проверьте границы периода публикации.") from None
    adapter = factory()
    initial_quota = adapter.quota_used_estimate
    page = source_call(
        adapter.search_videos, query=applied.query, limit=applied.limit,
        published_after=applied.published_after, published_before=applied.published_before,
        relevance_language=applied.relevance_language, page_token=applied.page_token,
    )
    fetched_at = utc_now()
    # Reuse batched source channel data; never issue one get_channel call per result.
    for channel in page.channels:
        upsert_channel(db, channel, fetched_at)
    unique = {}
    for video in page.videos:
        unique.setdefault(video.id, video)
    videos = list(unique.values())
    for video in videos:
        upsert_video(db, video, fetched_at)
    db.commit()
    matches = [video for video in videos if matches_filters(video, applied)]
    return SearchVideosResponse(
        query=applied.query, applied=applied, videos=[video_out(video) for video in matches],
        fetched_at=fetched_at, next_page_token=page.next_page_token,
        items_scanned=page.items_scanned, matched_count=len(matches),
        quota_used_estimate=adapter.quota_used_estimate - initial_quota,
    )

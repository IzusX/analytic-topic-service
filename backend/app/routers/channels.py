"""Explicitly sampled channel analytics, without evaluative verdicts."""
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas.channel import ChannelCardOut
from ..services.analysis import load_channel_analysis, source_video_context
from ..services.source import AdapterFactory, get_adapter_factory

router = APIRouter(prefix="/api/channels", tags=["channels"])


@router.get("/{channel_id}", response_model=ChannelCardOut)
def get_channel_card(
    channel_id: Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")],
    db: Session = Depends(get_db),
    factory: AdapterFactory = Depends(get_adapter_factory),
    force_sync: bool = False,
    source_video_id: Annotated[str | None, Query(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")] = None,
):
    result = load_channel_analysis(db, channel_id, factory, force_sync)
    if source_video_id is not None:
        result.source_video = source_video_context(db, result, source_video_id)
    return result

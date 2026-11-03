"""One bounded uploads sample and a coherent, explicitly refreshed analysis cache."""
from __future__ import annotations

from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..adapters.base import AdapterVideo
from ..models.channel import ChannelAnalysis, Video
from ..schemas.channel import ChannelCardOut, ChannelMetricsOut, ChannelOut
from ..schemas.common import SampleMetadata, SampleRule, SourceVideoOut, as_utc, utc_now
from ..schemas.video import VideoOut
from .metrics import channel_metrics, like_view_ratio, comment_view_ratio
from .presentation import video_out
from .source import AdapterFactory, api_error, source_call
from .sync import upsert_channel, upsert_video

RULE = SampleRule()
SAMPLE_CACHE_KEY = "youtube:service:gt180:limit30:scan200:pages4:v2"


def _summary(sample: SampleMetadata, metrics: ChannelMetricsOut) -> str:
    if sample.selected_count == 0:
        return "В доступной проверенной части загрузок нет видео с известной длительностью более 3 минут. Метрики не рассчитаны."
    if metrics.count == 0:
        return f"Отобрано {sample.selected_count} видео длительностью более 3 минут. Просмотры неизвестны у всех; метрики просмотров не рассчитаны."
    if metrics.count == 1:
        return f"Отобрано {sample.selected_count} видео; просмотры известны у одного: {metrics.max_views}. По одной записи повторяемость не определяется."
    maximum = f"Максимум — {metrics.spike_ratio:.2f} медианы." if metrics.spike_ratio is not None else "Максимум / медиана не определён: медиана равна нулю."
    return (
        f"Отобрано {sample.selected_count} видео; просмотры известны у {metrics.count}. "
        f"Медиана — {metrics.median_views:g}. {maximum} "
        f"У {round(metrics.consistency * metrics.count)} из {metrics.count} видео просмотры не ниже половины медианы."
    )


def load_channel_analysis(db: Session, channel_id: str, factory: AdapterFactory, force_sync: bool = False) -> ChannelCardOut:
    cache = db.get(ChannelAnalysis, (channel_id, SAMPLE_CACHE_KEY))
    if cache is not None and not force_sync:
        try:
            result = ChannelCardOut.model_validate(cache.payload)
        except ValidationError:
            pass  # A malformed/old cache is not evidence of a confirmed sample.
        else:
            return result.model_copy(update={"from_cache": True, "quota_used_estimate": 0, "source_video": None})

    adapter = factory()
    initial_quota = adapter.quota_used_estimate
    channel = source_call(adapter.get_channel, channel_id)
    if channel is None:
        raise api_error(404, "channel_not_found", "Канал не найден или недоступен.")
    if not channel.uploads_playlist_id:
        raise api_error(502, "uploads_unavailable", "Список загрузок канала недоступен. Предыдущий анализ сохранён.", True)

    selected: list[AdapterVideo] = []
    scanned_videos: list[AdapterVideo] = []
    seen_ids: set[str] = set()
    uploads_scanned = pages_scanned = unavailable_count = unknown_duration_count = excluded_duration_count = 0
    token = None
    stop_reason = "uploads_exhausted"
    if channel.uploads_playlist_id:
        for _ in range(RULE.max_pages):
            page = source_call(adapter.get_uploads_page, channel.uploads_playlist_id, page_token=token, limit=min(50, RULE.max_uploads_scanned - uploads_scanned))
            pages_scanned += 1
            uploads_scanned += page.items_scanned
            unavailable_count += max(0, page.items_scanned - len(page.videos))
            for video in page.videos:
                if video.id in seen_ids:
                    continue
                seen_ids.add(video.id)
                if video.channel_id != channel_id:
                    unavailable_count += 1
                    continue
                # Keep every available source-page video in storage, including short ones.
                video.channel_subscriber_count = channel.subscriber_count
                video.channel_subscriber_count_hidden = channel.subscriber_count_hidden
                if not video.channel_title:
                    video.channel_title = channel.title
                scanned_videos.append(video)
                if video.duration_seconds is None:
                    unknown_duration_count += 1
                    continue
                if video.duration_seconds <= RULE.min_duration_seconds:
                    excluded_duration_count += 1
                    continue
                if len(selected) < RULE.max_videos:
                    selected.append(video)
            if len(selected) == RULE.max_videos:
                stop_reason = "sample_full"
                break
            if page.next_page_token is None:
                stop_reason = "uploads_exhausted"
                break
            if uploads_scanned >= RULE.max_uploads_scanned or pages_scanned == RULE.max_pages:
                stop_reason = "scan_limit"
                break
            token = page.next_page_token

    observed = channel_metrics(selected)
    like_values = [value for video in selected if (value := like_view_ratio(video.like_count, video.view_count)) is not None]
    comment_values = [value for video in selected if (value := comment_view_ratio(video.comment_count, video.view_count)) is not None]
    metrics = ChannelMetricsOut(
        count=observed.count, median_views=observed.median_views, mean_views=observed.mean_views,
        std_views=observed.std_views, cv=observed.cv, spike_ratio=observed.spike_ratio,
        consistency=observed.consistency, max_views=observed.max_views, min_views=observed.min_views,
        avg_like_view=sum(like_values) / len(like_values) if like_values else None,
        avg_comment_view=sum(comment_values) / len(comment_values) if comment_values else None,
        like_view_count=len(like_values), comment_view_count=len(comment_values),
    )
    dates = [as_utc(video.published_at) for video in selected if video.published_at is not None]
    sample = SampleMetadata(
        rule=RULE, selected_count=len(selected), metric_count=metrics.count,
        uploads_scanned=uploads_scanned, pages_scanned=pages_scanned,
        unavailable_video_count=unavailable_count, unknown_duration_count=unknown_duration_count,
        excluded_duration_count=excluded_duration_count, unknown_date_count=len(selected) - len(dates),
        date_from=min(dates) if dates else None, date_to=max(dates) if dates else None,
        stop_reason=stop_reason, target_reached=len(selected) == RULE.max_videos,
        scan_limit_reached=stop_reason == "scan_limit",
    )
    ordered = sorted(
        (video for video in selected if video.published_at is not None),
        key=lambda video: (as_utc(video.published_at), video.id),
    ) + [video for video in selected if video.published_at is None]
    fetched_at = utc_now()
    channel_out = ChannelOut.model_validate(channel)
    channel_out.published_at = as_utc(channel_out.published_at)
    channel_out.last_synced_at = fetched_at
    if channel_out.subscriber_count_hidden is True:
        channel_out.subscriber_count = None
    result = ChannelCardOut(
        channel=channel_out, sample=sample, metrics=metrics, summary=_summary(sample, metrics),
        videos=[video_out(video, metrics.median_views) for video in ordered], fetched_at=fetched_at,
        quota_used_estimate=adapter.quota_used_estimate - initial_quota,
    )
    # No database mutation precedes successful completion of the source operation.
    upsert_channel(db, channel, fetched_at)
    for video in scanned_videos:
        upsert_video(db, video, fetched_at)
    if cache is None:
        cache = ChannelAnalysis(channel_id=channel_id, sample_key=SAMPLE_CACHE_KEY)
        db.add(cache)
    cache.fetched_at = fetched_at
    cache.payload = result.model_dump(mode="json")
    db.commit()
    return result


def source_video_context(db: Session, result: ChannelCardOut, source_video_id: str) -> SourceVideoOut:
    selected = next((video for video in result.videos if video.id == source_video_id), None)
    if selected is not None:
        return SourceVideoOut(id=source_video_id, status="included", view_median_ratio=selected.view_median_ratio)
    stored = db.get(Video, source_video_id)
    if stored is not None:
        # Prefer a coherent response snapshot; legacy rows are used only to explain known duration.
        video = VideoOut.model_validate(stored.source_payload) if stored.source_payload else VideoOut.model_validate(stored)
        if video.channel_id != result.channel.id:
            return SourceVideoOut(id=source_video_id, status="channel_mismatch", reason="Видео относится к другому каналу.")
        if video.duration_seconds is None:
            return SourceVideoOut(id=source_video_id, status="duration_unknown", reason="Длительность видео неизвестна; оно не входит в эту выборку.")
        if video.duration_seconds <= RULE.min_duration_seconds:
            return SourceVideoOut(id=source_video_id, status="duration_too_short", reason="Видео длится не более 3 минут и не входит в эту выборку.")
    return SourceVideoOut(id=source_video_id, status="not_in_sample", reason="Видео не входит в полученную выборку. Другое видео вместо него не выделяется.")

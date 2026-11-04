import type { EChartsOption } from 'echarts'
import type { ChannelCardOut, VideoOut } from '../../api'
import { fontFamily, palette } from '../../styles/theme'
import { formatExactCount, formatUtcDate, isKnownCount, noData } from '../../utils/presentation'

function knownMetric(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function formatMetric(value: number | null | undefined, digits = 1): string {
  return knownMetric(value)
    ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: Math.min(20, Math.max(0, Math.trunc(digits) || 0)) }).format(value)
    : noData
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return knownMetric(value)
    ? new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: Math.min(20, Math.max(0, Math.trunc(digits) || 0)) }).format(value)
    : noData
}

function publicationTime(video: VideoOut): number {
  const time = video.published_at ? Date.parse(video.published_at) : NaN
  return Number.isFinite(time) ? time : Infinity
}

/** A copy: dates ascending, preserving input order for equal and unknown dates. */
export function orderedVideos(videos: VideoOut[]): VideoOut[] {
  return videos.map((video, index) => ({ video, index }))
    .sort((a, b) => (publicationTime(a.video) - publicationTime(b.video)) || a.index - b.index)
    .map(({ video }) => video)
}

export function sourceContext(analysis: ChannelCardOut, sourceVideoId: string | null | undefined, sourceVideo?: VideoOut): { included: boolean; message: string } {
  if (!sourceVideoId) return { included: false, message: '' }
  const neutral = { included: false, message: 'Видео из поиска не входит в эту выборку. Сравнение с медианой не выполняется.' }
  const sourceMatches = sourceVideo?.id === sourceVideoId
  const member = analysis.videos.find(video => video.id === sourceVideoId)
  if (member && (!member.channel_id || member.channel_id === analysis.channel.id)) {
    return { included: true, message: 'Видео из поиска входит в выборку.' }
  }
  const backendSource = analysis.source_video?.id === sourceVideoId ? analysis.source_video : undefined
  if (!backendSource && sourceMatches && sourceVideo.channel_id && sourceVideo.channel_id !== analysis.channel.id) return neutral
  if (backendSource?.status === 'duration_unknown') return { included: false, message: 'Длительность видео из поиска неизвестна, поэтому оно не входит в ограниченную по длительности выборку. Сравнение с медианой не выполняется.' }
  if (backendSource?.status === 'channel_mismatch') return { included: false, message: 'Видео из поиска относится к другому каналу. Сравнение с медианой этого канала не выполняется.' }
  if (backendSource && backendSource.status !== 'duration_too_short') return neutral
  if (backendSource?.status === 'duration_too_short'
    || (sourceMatches && sourceVideo.channel_id === analysis.channel.id
      && isKnownCount(sourceVideo.duration_seconds) && sourceVideo.duration_seconds <= 180)) {
    return { included: false, message: 'Видео из поиска длится не более 180 секунд и не входит в выборку видео длиннее 180 секунд. Сравнение с медианой не выполняется.' }
  }
  return neutral
}

// richText has its own {style|text} syntax. User text must remain literal text.
function safeText(value: string): string {
  return value.replace(/[{}]/g, char => char === '{' ? '｛' : '｝').replace(/[\u0000-\u001f\u007f]/g, ' ')
}

export function chartOption(videos: VideoOut[], median: number | null | undefined, sourceVideoId?: string, reducedMotion = false): EChartsOption {
  const ordered = orderedVideos(videos)
  const labels = ordered.map((video, index) => {
    const date = Number.isFinite(publicationTime(video)) ? formatUtcDate(video.published_at) : `Дата неизвестна (${index + 1})`
    return video.id === sourceVideoId ? `${date}\nВидео из поиска` : date
  })
  return {
    animation: !reducedMotion,
    animationDuration: 250,
    textStyle: { fontFamily, color: palette.text },
    grid: { left: 16, right: 24, top: 48, bottom: 16, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    tooltip: {
      trigger: 'item', renderMode: 'richText', confine: true,
      backgroundColor: palette.raised, borderColor: palette.border,
      textStyle: { color: palette.text, fontFamily },
      formatter: params => {
        const item = Array.isArray(params) ? params[0] : params
        const video = item ? ordered[item.dataIndex] : undefined
        if (!video) return ''
        return `${safeText(video.title)}\n${labels[item!.dataIndex]}\nПросмотры: ${formatExactCount(video.view_count)}`
      },
    },
    xAxis: {
      type: 'category', data: labels,
      axisLine: { lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, hideOverlap: false, fontSize: 12,
        interval: (index: number) => ordered[index]?.id === sourceVideoId || index % Math.max(1, Math.ceil(ordered.length / 4)) === 0 },
    },
    yAxis: {
      type: 'value', min: 0, name: 'Просмотры',
      nameTextStyle: { color: palette.muted },
      axisLabel: { color: palette.muted },
      splitLine: { lineStyle: { color: palette.divider } },
    },
    series: [{
      type: 'bar', name: 'Просмотры', barMaxWidth: 40,
      itemStyle: { color: palette.data },
      emphasis: { disabled: true },
      data: ordered.map(video => ({
        value: isKnownCount(video.view_count) ? video.view_count : null,
        ...(video.id === sourceVideoId ? {
          itemStyle: { color: palette.data, borderColor: palette.data, borderWidth: 3, borderType: 'dashed' as const },
          label: { show: true, formatter: 'Видео из поиска', position: 'top' as const, color: palette.data, fontSize: 12 },
        } : {}),
      })),
      ...(knownMetric(median) ? {
        markLine: {
          silent: true, symbol: ['none', 'none'],
          lineStyle: { color: palette.median, type: 'dashed' as const, width: 2 },
          label: { position: 'insideEndTop' as const, color: palette.median, formatter: `Медиана: ${formatMetric(median)}` },
          data: [{ yAxis: median }],
        },
      } : {}),
    }],
  }
}

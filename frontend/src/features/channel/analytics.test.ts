import { describe, expect, it } from 'vitest'
import type { BarSeriesOption, TooltipComponentOption, XAXisComponentOption } from 'echarts'
import type { ChannelCardOut, VideoOut } from '../../api'
import { palette } from '../../styles/theme'
import { chartOption, formatMetric, formatPercent, orderedVideos, sourceContext } from './analytics'

const video = (id: string, extra: Partial<VideoOut> = {}): VideoOut => ({ id, title: id, channel_id: 'channel', ...extra })
const analysis = (videos: VideoOut[] = []): ChannelCardOut => ({
  channel: { id: 'channel', title: 'Канал' }, videos, metrics: { count: videos.length }, summary: '', fetched_at: '2026-01-01T00:00:00Z',
  sample: { selected_count: videos.length, metric_count: videos.length, uploads_scanned: videos.length, pages_scanned: 1, stop_reason: 'uploads_exhausted', target_reached: false, scan_limit_reached: false },
})
const series = (option: ReturnType<typeof chartOption>) => (option.series as BarSeriesOption[])[0]!

describe('analytics presentation', () => {
  it('orders dates without mutation; ties and missing/invalid dates remain stable', () => {
    const videos = [video('unknown'), video('new', { published_at: '2026-01-02' }), video('old', { published_at: '2026-01-01', view_count: 0 }), video('tie', { published_at: '2026-01-01' }), video('invalid', { published_at: 'bad' })]
    expect(orderedVideos(videos).map(v => v.id)).toEqual(['old', 'tie', 'new', 'unknown', 'invalid'])
    expect(videos[0]!.id).toBe('unknown')
    expect(orderedVideos(videos)[0]!.view_count).toBe(0)
  })

  it('formats fractional metrics and raw percentage fractions without inventing zeros', () => {
    expect(formatMetric(0)).toBe('0')
    expect(formatMetric(12.345, 2)).toBe('12,35')
    expect(formatPercent(0.125)).toMatch(/^12,5\s?%$/)
    expect(formatPercent(0)).toMatch(/^0\s?%$/)
    for (const missing of [undefined, null, NaN, Infinity, -1]) {
      expect(formatMetric(missing)).toBe('Нет данных')
      expect(formatPercent(missing)).toBe('Нет данных')
    }
  })

  it('uses actual coherent membership rather than included claims or another source', () => {
    expect(sourceContext(analysis([video('source')]), 'source').included).toBe(true)
    expect(sourceContext({ ...analysis(), source_video: { id: 'source', status: 'included' } }, 'source').included).toBe(false)
    expect(sourceContext(analysis([video('source', { channel_id: 'other' })]), 'source').included).toBe(false)
    expect(sourceContext(analysis([video('source')]), 'source', video('source', { channel_id: 'other' })).included).toBe(true)
    expect(sourceContext(analysis(), undefined)).toEqual({ included: false, message: '' })
  })

  it('explains known short sources only for matching identity and channel', () => {
    for (const duration_seconds of [0, 180]) {
      expect(sourceContext(analysis(), 'source', video('source', { duration_seconds })).message).toContain('не более 180')
    }
    for (const candidate of [video('other', { duration_seconds: 30 }), video('source', { channel_id: 'other', duration_seconds: 30 }), video('source'), video('source', { duration_seconds: 181 })]) {
      expect(sourceContext(analysis(), 'source', candidate).message).not.toContain('не более 180')
    }
    expect(sourceContext({ ...analysis(), source_video: { id: 'source', status: 'duration_too_short' } }, 'source').message).toContain('не более 180')
    for (const status of ['duration_unknown', 'not_in_sample', 'channel_mismatch'] as const) {
      expect(sourceContext({ ...analysis(), source_video: { id: 'source', status } }, 'source').message).not.toContain('не более 180')
    }
    expect(sourceContext({ ...analysis(), source_video: { id: 'different', status: 'duration_too_short' } }, 'source').message).not.toContain('не более 180')
  })

  it('charts actual zero and unknown gaps on ordinal date categories', () => {
    const option = chartOption([video('missing'), video('zero', { published_at: '2026-01-01', view_count: 0 }), video('bad', { published_at: 'invalid', view_count: NaN })], 0, 'zero', true)
    expect(option.animation).toBe(false)
    const bars = series(option)
    expect(bars.data).toMatchObject([{ value: 0, label: { formatter: 'Видео из поиска', color: palette.data }, itemStyle: { color: palette.data, borderColor: palette.data } }, { value: null }, { value: null }])
    expect(bars.markLine).toMatchObject({ data: [{ yAxis: 0 }], lineStyle: { color: palette.median } })
    const axis = option.xAxis as XAXisComponentOption
    expect(axis.type).toBe('category')
    if (axis.type !== 'category') throw new Error('Expected category axis')
    expect(axis.data).toEqual(['01.01.2026\nВидео из поиска', 'Дата неизвестна (2)', 'Дата неизвестна (3)'])
  })

  it('omits invalid median, leaves unmatched sources unhighlighted, and renders text tooltips safely', () => {
    for (const median of [null, undefined, NaN, Infinity, -1]) expect(series(chartOption([], median)).markLine).toBeUndefined()
    const option = chartOption([video('v', { title: '<img src=x onerror=bad>{evil|title}', view_count: 10 })], 5, 'missing')
    expect(series(option).data).toEqual([{ value: 10 }])
    const tooltip = option.tooltip as TooltipComponentOption
    expect(tooltip.renderMode).toBe('richText')
    const formatter = tooltip.formatter as (params: unknown) => string
    const text = formatter({ dataIndex: 0 })
    expect(text).toContain('<img src=x onerror=bad>')
    expect(text).not.toContain('{evil|')
    expect(text).toContain('Просмотры: 10')
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { VideoOut } from '../../api'
import { deduplicateVideos, sortOptions, sortVideos } from './results'

const video = (id: string, fields: Partial<VideoOut> = {}): VideoOut => ({ id, title: id, ...fields })
const ids = (videos: VideoOut[]) => videos.map(item => item.id)

describe('result transforms', () => {
  it('retains first whole objects without modifying frozen source arrays', () => {
    const first = video('same', { view_count: null })
    const source = Object.freeze([first, video('same', { view_count: 100, channel_title: 'new' }), video('other')])
    const result = deduplicateVideos(source)
    expect(result).toEqual([first, source[2]])
    expect(result[0]).toBe(first)
    expect(result[0]).not.toHaveProperty('channel_title')
    expect(source).toHaveLength(3)
  })

  it('sorts counts descending, stable on ties, with zero valid and unknown/invalid last', () => {
    const source = Object.freeze([video('null', { view_count: null }), video('zero', { view_count: 0 }),
      video('a', { view_count: 10 }), video('b', { view_count: 10 }), video('negative', { view_count: -1 }),
      video('nan', { view_count: NaN }), video('missing')])
    expect(ids(sortVideos(source, 'views'))).toEqual(['a', 'b', 'zero', 'null', 'negative', 'nan', 'missing'])
    expect(sortVideos(source, 'original')).toEqual(source)
    expect(sortVideos(source, 'original')).not.toBe(source)
    expect(source[0]?.id).toBe('null')
  })

  it('sorts dates including the epoch and pre-epoch timestamps ahead of invalid dates', () => {
    const source = [video('bad', { published_at: 'invalid' }), video('old', { published_at: '1960-01-01T00:00:00Z' }),
      video('epoch', { published_at: '1970-01-01T00:00:00Z' }), video('new', { published_at: '2026-01-01T00:00:00Z' }),
      video('tie', { published_at: '2026-01-01T00:00:00Z' }), video('missing')]
    expect(ids(sortVideos(source, 'date'))).toEqual(['new', 'tie', 'epoch', 'old', 'bad', 'missing'])
  })

  it('uses knownRatio, excluding hidden, zero-subscriber and invalid ratios while retaining zero', () => {
    const source = [video('hidden', { channel_subscriber_count: 10, channel_subscriber_count_hidden: true, view_sub_ratio: 100 }),
      video('zero-subs', { channel_subscriber_count: 0, view_sub_ratio: 99 }),
      video('zero', { channel_subscriber_count: 10, view_sub_ratio: 0 }),
      video('high', { channel_subscriber_count: 10, view_sub_ratio: 2 }),
      video('tie', { channel_subscriber_count: 10, view_sub_ratio: 2 }),
      video('infinity', { channel_subscriber_count: 10, view_sub_ratio: Infinity }), video('missing')]
    expect(ids(sortVideos(source, 'ratio'))).toEqual(['high', 'tie', 'zero', 'hidden', 'zero-subs', 'infinity', 'missing'])
    expect(sortOptions.map(option => option.value)).toEqual(['original', 'views', 'date', 'ratio'])
  })
})

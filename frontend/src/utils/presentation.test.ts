// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatCompactCount, formatDuration, formatExactCount, formatRatio, formatUtcDate, isResourceId, knownRatio, noData, ratioLevel, thumbnailUrl } from './presentation'

const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ')

describe('video presentation', () => {
  it.each([null, undefined, -1, NaN, Infinity, 1.5])('does not invent a count for %s', value => {
    expect(formatExactCount(value)).toBe(noData)
    expect(formatCompactCount(value)).toBe(noData)
    expect(formatDuration(value)).toBe(noData)
  })
  it('keeps zero known, including zero duration', () => {
    expect(formatExactCount(0)).toBe('0')
    expect(formatCompactCount(0)).toBe('0')
    expect(formatDuration(0)).toBe('0:00')
    expect(plain(formatExactCount(16000))).toBe('16 000')
  })
  it.each([[180, '3:00'], [181, '3:01'], [3600, '1:00:00'], [90061, '25:01:01']])('formats exact duration %i', (seconds, expected) => {
    expect(formatDuration(seconds as number)).toBe(expected)
  })
  it('uses UTC and handles missing/invalid dates', () => {
    expect(formatUtcDate('2026-01-01T01:00:00+03:00')).toBe('31.12.2025')
    expect(formatUtcDate('2026-01-01T01:00:00Z', true)).toContain('01:00 UTC')
    expect(formatUtcDate(null)).toBe(noData)
    expect(formatUtcDate('bad')).toBe(noData)
  })
  it('does not calculate a ratio from unavailable or zero subscribers', () => {
    expect(knownRatio({ view_sub_ratio: 12, channel_subscriber_count: 10, channel_subscriber_count_hidden: true })).toBeNull()
    expect(knownRatio({ view_sub_ratio: 12, channel_subscriber_count: null })).toBeNull()
    expect(knownRatio({ view_sub_ratio: 0, channel_subscriber_count: 0 })).toBeNull()
    expect(knownRatio({ view_sub_ratio: 0, channel_subscriber_count: 10 })).toBe(0)
  })
  it.each([[null, 'unknown'], [0, 'low'], [0.999, 'low'], [1, 'mild'], [2.999, 'mild'], [3, 'medium'], [9.999, 'medium'], [10, 'high']])('uses fixed intensity for %s', (value, expected) => {
    expect(ratioLevel(value as number | null)).toBe(expected)
  })
  it('marks rounded ratio values as approximate rather than disguising a boundary', () => {
    expect(formatRatio(null)).toBe('—')
    expect(formatRatio(0)).toBe('0×')
    expect(formatRatio(1.8)).toBe('1,8×')
    expect(formatRatio(2.999)).toBe('≈3×')
  })
  it('accepts only safe image URL schemes and resource identifiers', () => {
    expect(thumbnailUrl('https://i.ytimg.com/vi/example/hqdefault.jpg')).toContain('https://i.ytimg.com/')
    expect(thumbnailUrl('javascript:alert(1)')).toBeNull()
    expect(thumbnailUrl('https://name:password@example.com/image')).toBeNull()
    expect(thumbnailUrl('bad')).toBeNull()
    expect(isResourceId('video_-')).toBe(true)
    expect(isResourceId('..')).toBe(false)
    expect(isResourceId('video/other')).toBe(false)
  })
})

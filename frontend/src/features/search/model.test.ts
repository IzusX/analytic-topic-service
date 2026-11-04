// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SearchVideosRequest } from '../../api'
import { createEmptyDraft, createRefreshRequest, criteriaKey, validateDraft } from './model'
import type { SearchDraft } from './model'
import { durationOptions, periodOptions } from './options'
import type { DurationRange } from './options'

function requestFrom(patch: Partial<SearchDraft> = {}): SearchVideosRequest {
  const result = validateDraft({ ...createEmptyDraft(), ...patch })
  expect(result.valid).toBe(true)
  if (!result.valid) throw new Error('Expected a valid draft')
  expect(result.errors).toEqual({})
  return result.request
}

describe('search draft validation', () => {
  it('creates independent cleared drafts and range arrays', () => {
    const first = createEmptyDraft()
    const second = createEmptyDraft()
    expect(first).toEqual({
      query: '', language: '', minSubscribers: '', maxSubscribers: '', period: 'all', durationRanges: [],
    })
    expect(first).not.toBe(second)
    expect(first.durationRanges).not.toBe(second.durationRanges)
    first.durationRanges.push('over_60m')
    expect(second.durationRanges).toEqual([])
    expect(createEmptyDraft().durationRanges).toEqual([])
  })

  it('accepts an optional topic and sends exactly one first-page limit of 50', () => {
    const request = requestFrom({ query: ' \n\t ' })
    expect(request).toEqual({ query: '', limit: 50, period: 'all', duration_ranges: [] })
    expect(request).not.toHaveProperty('relevance_language')
    expect(request).not.toHaveProperty('min_subscribers')
    expect(request).not.toHaveProperty('max_subscribers')
    expect(request).not.toHaveProperty('published_after')
    expect(request).not.toHaveProperty('published_before')
    expect(request).not.toHaveProperty('page_token')
  })

  it('trims the topic without mutating its draft', () => {
    const draft = { ...createEmptyDraft(), query: '  中文 ремонт 🚙  ' }
    const result = validateDraft(draft)
    expect(result).toMatchObject({ valid: true, request: { query: '中文 ремонт 🚙' } })
    expect(draft.query).toBe('  中文 ремонт 🚙  ')
  })

  it.each(['a', '中', '🚙'])('counts the 500-character topic boundary in codepoints (%s)', character => {
    expect(requestFrom({ query: `  ${character.repeat(500)}  ` }).query).toBe(character.repeat(500))
    const result = validateDraft({ ...createEmptyDraft(), query: character.repeat(501) })
    expect(result.valid).toBe(false)
    expect(result.errors.query).toEqual(expect.any(String))
    expect(result).not.toHaveProperty('request')
  })

  it('preserves inclusive zero bounds and does not add absent bounds', () => {
    expect(requestFrom({ minSubscribers: '0', maxSubscribers: '0' }))
      .toMatchObject({ min_subscribers: 0, max_subscribers: 0 })
    expect(requestFrom({ minSubscribers: '000', maxSubscribers: '001' }))
      .toMatchObject({ min_subscribers: 0, max_subscribers: 1 })
    expect(requestFrom({ minSubscribers: '0' })).not.toHaveProperty('max_subscribers')
    expect(requestFrom({ maxSubscribers: '0' })).not.toHaveProperty('min_subscribers')
  })

  it('accepts safe integers up to the exact upper boundary without clamping', () => {
    const raw = String(Number.MAX_SAFE_INTEGER)
    expect(requestFrom({ minSubscribers: raw, maxSubscribers: raw }))
      .toMatchObject({ min_subscribers: Number.MAX_SAFE_INTEGER, max_subscribers: Number.MAX_SAFE_INTEGER })
  })

  it.each([
    '-1', '-0', '+1', '1.0', '1.5', '1e3', '0x10', '1_000', '1,000', 'NaN', 'Infinity', 'true',
    ' ', ' 1', '1 ', '1\n', '\t1', '１２', '١', '9007199254740992', '999999999999999999999999999999999999',
  ])('rejects raw subscriber input %j rather than coercing or clamping it', raw => {
    const result = validateDraft({ ...createEmptyDraft(), minSubscribers: raw, maxSubscribers: raw })
    expect(result.valid).toBe(false)
    expect(result.errors.minSubscribers).toEqual(expect.any(String))
    expect(result.errors.maxSubscribers).toEqual(expect.any(String))
    expect(result).not.toHaveProperty('request')
  })

  it('rejects reversed bounds and accepts equal nonzero bounds', () => {
    const result = validateDraft({ ...createEmptyDraft(), minSubscribers: '11', maxSubscribers: '10' })
    expect(result.valid).toBe(false)
    expect(result.errors.maxSubscribers).toEqual(expect.any(String))
    expect(requestFrom({ minSubscribers: '10', maxSubscribers: '10' }))
      .toMatchObject({ min_subscribers: 10, max_subscribers: 10 })
  })

  it('accepts only the option periods', () => {
    for (const { value } of periodOptions) expect(requestFrom({ period: value }).period).toBe(value)
    const result = validateDraft({ ...createEmptyDraft(), period: 'quarter' as SearchDraft['period'] })
    expect(result.valid).toBe(false)
    expect(result.errors.period).toEqual(expect.any(String))
  })

  it.each(['', 'ru', 'en', 'zh-Hans', 'zh-Hant'])('accepts the supported language %j', language => {
    const request = requestFrom({ language })
    if (language === '') expect(request).not.toHaveProperty('relevance_language')
    else expect(request.relevance_language).toBe(language)
  })

  it.each(['zh', 'zh-CN', 'zh-TW', 'zh-HANS', 'RU', ' en ', 'unknown'])('rejects unsupported language %j', language => {
    const result = validateDraft({ ...createEmptyDraft(), language })
    expect(result.valid).toBe(false)
    expect(result.errors.language).toEqual(expect.any(String))
  })

  it('canonicalizes the duration union without mutating or sharing the source array', () => {
    const ranges: DurationRange[] = ['over_60m', '3_to_10m', 'up_to_3m', '3_to_10m', '30_to_60m', '10_to_30m']
    const original = [...ranges]
    const request = requestFrom({ durationRanges: ranges })
    expect(request.duration_ranges).toEqual(durationOptions.map(option => option.value))
    expect(ranges).toEqual(original)
    expect(request.duration_ranges).not.toBe(ranges)
    ranges.push('over_60m')
    expect(request.duration_ranges).toHaveLength(5)
  })

  it('rejects unknown duration values and invalid range containers', () => {
    for (const durationRanges of [['short'], null] as unknown as DurationRange[][]) {
      const result = validateDraft({ ...createEmptyDraft(), durationRanges })
      expect(result.valid).toBe(false)
      expect(result.errors.durationRanges).toEqual(expect.any(String))
    }
  })
})

describe('criteria comparison', () => {
  it('normalizes backend defaults without including frozen dates, tokens, or API-only filters', () => {
    const applied: SearchVideosRequest = {
      query: ' ', limit: 7, period: 'all', relevance_language: null, duration_ranges: [],
      min_subscribers: null, max_subscribers: null, min_views: 0, max_views: null,
      published_after: '2025-01-01T00:00:00Z', published_before: '2026-01-01T00:00:00Z', page_token: 'opaque',
    }
    expect(criteriaKey(applied)).toBe(criteriaKey(requestFrom()))
    expect(criteriaKey({})).toBe(criteriaKey(requestFrom()))
  })

  it('compares duration sets in canonical order without changing either request', () => {
    const first: SearchVideosRequest = { query: '  тема ', period: 'month', duration_ranges: ['over_60m', 'up_to_3m', 'up_to_3m'] }
    const second: SearchVideosRequest = { query: 'тема', period: 'month', duration_ranges: ['up_to_3m', 'over_60m'], published_after: '2026-01-01T00:00:00Z' }
    expect(criteriaKey(first)).toBe(criteriaKey(second))
    expect(first.duration_ranges).toEqual(['over_60m', 'up_to_3m', 'up_to_3m'])
    expect(second.duration_ranges).toEqual(['up_to_3m', 'over_60m'])
  })

  it.each([
    { label: 'query', request: { query: 'тема' } },
    { label: 'language', request: { relevance_language: 'zh-Hans' } },
    { label: 'minimum zero', request: { min_subscribers: 0 } },
    { label: 'maximum zero', request: { max_subscribers: 0 } },
    { label: 'period', request: { period: 'day' } },
    { label: 'duration', request: { duration_ranges: ['up_to_3m'] } },
  ] satisfies Array<{ label: string; request: SearchVideosRequest }>)('distinguishes editable $label', ({ request }) => {
    expect(criteriaKey(request)).not.toBe(criteriaKey({}))
  })
})

describe('explicit refresh request', () => {
  it.each(['day', 'week', 'month', 'year'] as const)('removes the frozen lower boundary for relative period %s', period => {
    const applied: SearchVideosRequest = {
      query: 'применённая тема', limit: 50, period, relevance_language: 'zh-Hant',
      duration_ranges: ['over_60m', 'up_to_3m'], min_subscribers: 0, max_subscribers: 100,
      min_views: 0, max_views: null, published_after: '2025-01-01T00:00:00Z',
      published_before: '2026-01-01T00:00:00Z', page_token: 'opaque',
    }
    const request = createRefreshRequest(applied)
    expect(request).toEqual({
      query: 'применённая тема', limit: 50, period, relevance_language: 'zh-Hant',
      duration_ranges: ['over_60m', 'up_to_3m'], min_subscribers: 0, max_subscribers: 100,
      min_views: 0, max_views: null, published_before: '2026-01-01T00:00:00Z',
    })
    expect(request).not.toHaveProperty('page_token')
    expect(request).not.toHaveProperty('published_after')
    expect(request.duration_ranges).not.toBe(applied.duration_ranges)
    request.duration_ranges?.push('3_to_10m')
    expect(applied.duration_ranges).toEqual(['over_60m', 'up_to_3m'])
    expect(applied.published_after).toBe('2025-01-01T00:00:00Z')
    expect(applied.page_token).toBe('opaque')
  })

  it.each([{ period: 'all' as const }, {}])('retains explicit all-time boundaries and applied null/zero values (%j)', period => {
    const applied: SearchVideosRequest = {
      ...period, query: '', limit: 1, published_after: '2025-01-01T00:00:00Z', published_before: null,
      min_subscribers: 0, max_subscribers: null, relevance_language: null, page_token: null,
    }
    expect(createRefreshRequest(applied)).toEqual({
      ...period, query: '', limit: 1, published_after: '2025-01-01T00:00:00Z', published_before: null,
      min_subscribers: 0, max_subscribers: null, relevance_language: null,
    })
  })
})

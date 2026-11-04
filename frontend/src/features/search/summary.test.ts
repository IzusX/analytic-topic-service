// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { describeCriteria } from './summary'

describe('applied search description', () => {
  it('describes an optional topic without inventing filters', () => {
    const description = describeCriteria({ query: '', period: 'all', duration_ranges: [] })
    expect(description).toContain('Без темы')
    expect(description).toContain('Любой язык')
    expect(description).toContain('любое число подписчиков')
    expect(description).toContain('любая длительность')
  })
  it('preserves an explicit zero bound and preferred language', () => {
    const description = describeCriteria({ query: ' Python ', relevance_language: 'en', min_subscribers: 0, max_subscribers: 1000, period: 'month', duration_ranges: ['3_to_10m'] })
    expect(description).toContain('«Python»')
    expect(description).toContain('Английский')
    expect(description).toContain('от 0')
    expect(description).toContain('За месяц')
    expect(description).toContain('3–10 мин')
  })
  it('does not call all five active duration filters the same as no duration filter', () => {
    const description = describeCriteria({ duration_ranges: ['up_to_3m', '3_to_10m', '10_to_30m', '30_to_60m', 'over_60m'] })
    expect(description).toContain('До 3 мин')
    expect(description).toContain('Более часа')
    expect(description).not.toContain('любая длительность')
  })
})

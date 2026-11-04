import type { SearchVideosRequest } from '../../api'
import { allowedLanguages, durationOptions, periodOptions } from './options'
import type { DurationRange, SearchPeriod } from './options'

export interface SearchDraft {
  query: string
  language: string
  minSubscribers: string
  maxSubscribers: string
  period: SearchPeriod
  durationRanges: DurationRange[]
}

export type SearchDraftField = keyof SearchDraft
export type SearchErrors = Partial<Record<SearchDraftField, string>>

export function createEmptyDraft(): SearchDraft {
  return {
    query: '',
    language: '',
    minSubscribers: '',
    maxSubscribers: '',
    period: 'all',
    durationRanges: [],
  }
}

function subscriberBound(
  raw: string,
  field: 'minSubscribers' | 'maxSubscribers',
  errors: SearchErrors,
): number | undefined {
  if (raw === '') return undefined
  if (/[^0-9]/.test(raw)) {
    errors[field] = 'Введите целое неотрицательное число.'
    return undefined
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    errors[field] = 'Число превышает безопасный целочисленный диапазон.'
    return undefined
  }
  return value
}

function canonicalRanges(ranges: readonly DurationRange[]): DurationRange[] {
  return durationOptions.filter(option => ranges.includes(option.value)).map(option => option.value)
}

export function validateDraft(draft: SearchDraft):
  | { valid: true; request: SearchVideosRequest; errors: Record<string, never> }
  | { valid: false; errors: SearchErrors } {
  const errors: SearchErrors = {}
  const query = draft.query.trim()
  if (Array.from(query).length > 500) {
    errors.query = 'Тема поиска не должна превышать 500 символов.'
  }
  if (draft.language !== '' && !allowedLanguages.has(draft.language)) {
    errors.language = 'Выберите язык из списка.'
  }
  if (!periodOptions.some(option => option.value === draft.period)) {
    errors.period = 'Выберите период из списка.'
  }
  if (!Array.isArray(draft.durationRanges)
    || draft.durationRanges.some(range => !durationOptions.some(option => option.value === range))) {
    errors.durationRanges = 'Выберите длительность из списка.'
  }

  const minSubscribers = subscriberBound(draft.minSubscribers, 'minSubscribers', errors)
  const maxSubscribers = subscriberBound(draft.maxSubscribers, 'maxSubscribers', errors)
  if (minSubscribers !== undefined && maxSubscribers !== undefined && minSubscribers > maxSubscribers) {
    errors.maxSubscribers = 'Максимум подписчиков не может быть меньше минимума.'
  }
  if (Object.keys(errors).length > 0) return { valid: false, errors }

  const request: SearchVideosRequest = {
    query,
    limit: 50,
    period: draft.period,
    duration_ranges: canonicalRanges(draft.durationRanges),
  }
  if (draft.language !== '') request.relevance_language = draft.language
  if (minSubscribers !== undefined) request.min_subscribers = minSubscribers
  if (maxSubscribers !== undefined) request.max_subscribers = maxSubscribers
  return { valid: true, request, errors: {} }
}

/** Only editable criteria participate; server dates, continuation, and API-only filters do not. */
export function criteriaKey(request: SearchVideosRequest): string {
  return JSON.stringify({
    query: request.query?.trim() ?? '',
    language: request.relevance_language ?? '',
    minSubscribers: request.min_subscribers ?? null,
    maxSubscribers: request.max_subscribers ?? null,
    period: request.period ?? 'all',
    durationRanges: canonicalRanges(request.duration_ranges ?? []),
  })
}

export function createRefreshRequest(applied: SearchVideosRequest): SearchVideosRequest {
  const request = { ...applied }
  if (applied.duration_ranges !== undefined) request.duration_ranges = [...applied.duration_ranges]
  delete request.page_token
  if ((request.period ?? 'all') !== 'all') delete request.published_after
  return request
}

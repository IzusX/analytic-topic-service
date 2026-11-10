// @vitest-environment node
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import type { ApiClient, SearchVideosRequest, SearchVideosResponse } from '../api'
import { createEmptyDraft } from '../features/search/model'
import type { DurationRange } from '../features/search/options'
import defaultSearchStore, { createSearchStore, useSearchStore } from './search'

const fetchedAt = '2026-02-01T12:00:00Z'

function responseFor(request: SearchVideosRequest = {}, overrides: Partial<SearchVideosResponse> = {}): SearchVideosResponse {
  const applied = { ...request }
  if (request.duration_ranges !== undefined) applied.duration_ranges = [...request.duration_ranges]
  return {
    query: request.query ?? '', applied, videos: [], fetched_at: fetchedAt,
    items_scanned: 0, matched_count: 0, quota_used_estimate: 0,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function harness() {
  const searchVideos = vi.fn<ApiClient['searchVideos']>().mockImplementation(async request => responseFor(request))
  const getChannel = vi.fn<ApiClient['getChannel']>()
  const getVideo = vi.fn<ApiClient['getVideo']>()
  const api: ApiClient = { searchVideos, getChannel, getVideo }
  const factory = vi.fn(() => api)
  const store = createSearchStore(factory)(createPinia())
  return { store, factory, searchVideos, getChannel, getVideo }
}

function networkError(): ApiError {
  return new ApiError('Не удалось связаться с сервисом. Попробуйте ещё раз.', { code: 'network_error', retryable: true })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('explicit search state', () => {
  it('exports the default store and makes no calls at construction, draft edits, or reset', async () => {
    expect(defaultSearchStore).toBe(useSearchStore)
    expect(useSearchStore.$id).toBe('search')
    const { store, factory, searchVideos, getChannel, getVideo } = harness()
    expect(store.draft).toEqual(createEmptyDraft())
    expect(store.response).toBeNull()
    expect(store.pending).toBeNull()
    expect(store.error).toBeNull()
    expect(store.fieldErrors).toEqual({})
    expect(store.busy).toBe(false)
    expect(store.hasDraftChanges).toBe(false)
    expect(store.canRetry).toBe(false)
    const ranges: DurationRange[] = ['over_60m']
    store.patchDraft({ query: 'тема', language: 'ru', durationRanges: ranges })
    ranges.push('up_to_3m')
    expect(store.draft.durationRanges).toEqual(['over_60m'])
    store.resetFilters()
    store.clearFieldError('query')
    expect(store.draft).toEqual({ ...createEmptyDraft(), query: 'тема' })
    expect(await store.refresh()).toBe(false)
    expect(await store.retry()).toBe(false)
    store.cancel()
    expect(factory).not.toHaveBeenCalled()
    expect(searchVideos).not.toHaveBeenCalled()
    expect(getChannel).not.toHaveBeenCalled()
    expect(getVideo).not.toHaveBeenCalled()
  })

  it('allows searching without a topic and never follows a next-page token or loads channels', async () => {
    const { store, factory, searchVideos, getChannel, getVideo } = harness()
    searchVideos.mockImplementationOnce(async request => responseFor(request, { next_page_token: 'opaque-next-page' }))
    expect(await store.search()).toBe(true)
    expect(searchVideos).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(searchVideos.mock.calls[0]?.[0]).toEqual({ query: '', limit: 50, period: 'all', duration_ranges: [] })
    expect(searchVideos.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(store.response?.next_page_token).toBe('opaque-next-page')
    expect(store.hasDraftChanges).toBe(false)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
    expect(getChannel).not.toHaveBeenCalled()
    expect(getVideo).not.toHaveBeenCalled()
  })

  it('validates before client creation and clears only relevant field errors on edits/reset', async () => {
    const { store, factory, searchVideos } = harness()
    store.patchDraft({ query: '中'.repeat(501), language: 'zh', minSubscribers: '-1', maxSubscribers: '1e3' })
    expect(await store.search()).toBe(false)
    expect(store.fieldErrors).toEqual({
      query: expect.any(String), language: expect.any(String), minSubscribers: expect.any(String), maxSubscribers: expect.any(String),
    })
    expect(store.error).toBeNull()
    expect(store.canRetry).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(searchVideos).not.toHaveBeenCalled()
    store.patchDraft({ minSubscribers: '0' })
    expect(store.fieldErrors).not.toHaveProperty('minSubscribers')
    expect(store.fieldErrors.query).toEqual(expect.any(String))
    store.clearFieldError('maxSubscribers')
    expect(store.fieldErrors).not.toHaveProperty('maxSubscribers')
    const draftIdentity = store.draft
    store.resetFilters()
    expect(store.draft).toBe(draftIdentity)
    expect(store.draft.query).toBe('中'.repeat(501))
    expect(store.fieldErrors).toEqual({ query: expect.any(String) })
    expect(factory).not.toHaveBeenCalled()
  })

  it('compares editable draft with backend applied criteria, not frozen dates or raw formatting', async () => {
    const { store, searchVideos } = harness()
    store.patchDraft({ query: '  тема ', period: 'month', minSubscribers: '000', durationRanges: ['over_60m', 'up_to_3m'] })
    const applied: SearchVideosRequest = {
      query: 'тема', limit: 50, period: 'month', relevance_language: null, min_subscribers: 0, max_subscribers: null,
      duration_ranges: ['up_to_3m', 'over_60m'], published_after: '2026-01-01T12:00:00Z', published_before: null,
      min_views: null, max_views: null, page_token: null,
    }
    const result = responseFor(applied)
    searchVideos.mockResolvedValueOnce(result)
    expect(await store.search()).toBe(true)
    expect(store.response).toBe(result)
    expect(store.response?.applied.published_after).toBe('2026-01-01T12:00:00Z')
    expect(store.draft.query).toBe('  тема ')
    expect(store.hasDraftChanges).toBe(false)
    store.patchDraft({ language: 'zh-Hans' })
    expect(store.hasDraftChanges).toBe(true)
    expect(store.response?.applied.relevance_language).toBeNull()
    store.patchDraft({ language: '', durationRanges: ['over_60m', 'up_to_3m', 'over_60m'] })
    expect(store.hasDraftChanges).toBe(false)
    store.patchDraft({ maxSubscribers: '-1' })
    expect(store.hasDraftChanges).toBe(true)
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })

  it('resets only draft filters, retaining the query, response, and fresh range arrays', async () => {
    const { store, factory } = harness()
    store.patchDraft({ query: 'тема', language: 'ru', minSubscribers: '0', maxSubscribers: '50', period: 'week', durationRanges: ['up_to_3m'] })
    expect(await store.search()).toBe(true)
    const response = store.response
    const previousRanges = store.draft.durationRanges
    store.resetFilters()
    expect(store.draft).toEqual({ ...createEmptyDraft(), query: 'тема' })
    expect(store.draft.durationRanges).not.toBe(previousRanges)
    expect(store.response).toBe(response)
    expect(store.hasDraftChanges).toBe(true)
    store.draft.durationRanges.push('over_60m')
    store.resetFilters()
    expect(store.draft.durationRanges).toEqual([])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('keeps source order, zero metrics, unknown nulls, and server page metadata unchanged', async () => {
    const { store, searchVideos, getChannel, getVideo } = harness()
    const result = responseFor({}, {
      videos: [
        { id: 'z', title: 'Первый', view_count: 0, duration_seconds: 0, channel_subscriber_count: 0, view_sub_ratio: null },
        { id: 'a', title: 'Второй', view_count: null, duration_seconds: null, channel_subscriber_count: null, channel_subscriber_count_hidden: null },
        { id: 'm', title: 'Третий', view_count: 500, view_sub_ratio: 0, like_count: 0, like_view_ratio: 0 },
      ],
      items_scanned: 50, matched_count: 3, quota_used_estimate: 0, next_page_token: 'opaque', order: 'relevance',
    })
    searchVideos.mockResolvedValueOnce(result)
    expect(await store.search()).toBe(true)
    expect(store.response).toBe(result)
    expect(store.response?.videos.map(video => video.id)).toEqual(['z', 'a', 'm'])
    expect(store.response?.videos[0]?.view_count).toBe(0)
    expect(store.response?.videos[1]?.view_count).toBeNull()
    expect(store.response?.videos[1]?.channel_subscriber_count_hidden).toBeNull()
    expect(store.response?.videos[2]?.like_view_ratio).toBe(0)
    expect(searchVideos).toHaveBeenCalledTimes(1)
    expect(getChannel).not.toHaveBeenCalled()
    expect(getVideo).not.toHaveBeenCalled()
  })
})

describe('pending snapshots and preservation', () => {
  it('copies request ranges before await, blocks duplicate actions, and does not cancel on reset', async () => {
    const { store, factory, searchVideos } = harness()
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    const ranges: DurationRange[] = ['over_60m', 'up_to_3m']
    store.patchDraft({ query: ' первая ', language: 'ru', minSubscribers: '0', period: 'day', durationRanges: ranges })
    const request: SearchVideosRequest = {
      query: 'первая', limit: 50, period: 'day', duration_ranges: ['up_to_3m', 'over_60m'], relevance_language: 'ru', min_subscribers: 0,
    }
    const action = store.search()
    const pending = store.pending
    const signal = searchVideos.mock.calls[0]?.[1]?.signal
    expect(store.busy).toBe(true)
    expect(pending).toEqual({ kind: 'search', request })
    expect(pending?.request).not.toBe(searchVideos.mock.calls[0]?.[0])
    expect(pending?.request.duration_ranges).not.toBe(searchVideos.mock.calls[0]?.[0].duration_ranges)
    store.patchDraft({ query: 'позже', language: 'zh-Hant', minSubscribers: '100', period: 'year' })
    store.draft.durationRanges.push('3_to_10m')
    ranges.push('10_to_30m')
    expect(await store.search()).toBe(false)
    expect(await store.refresh()).toBe(false)
    expect(await store.retry()).toBe(false)
    store.resetFilters()
    expect(store.pending).toBe(pending)
    expect(store.pending?.request).toEqual(request)
    expect(searchVideos.mock.calls[0]?.[0]).toEqual(request)
    expect(signal?.aborted).toBe(false)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(searchVideos).toHaveBeenCalledTimes(1)
    task.resolve(responseFor(request, { applied: { ...request, published_after: '2026-01-31T12:00:00Z' } }))
    expect(await action).toBe(true)
    expect(store.draft).toEqual({ ...createEmptyDraft(), query: 'позже' })
    expect(store.response?.applied.query).toBe('первая')
    expect(store.hasDraftChanges).toBe(true)
    expect(store.busy).toBe(false)
  })

  it('keeps old videos and their applied labels throughout a later loading state and failure', async () => {
    const { store, factory, searchVideos } = harness()
    store.patchDraft({ query: 'первая', language: 'ru' })
    const previous = responseFor({ query: 'первая', limit: 50, period: 'all', relevance_language: 'ru' }, {
      videos: [{ id: 'old', title: 'Старое видео' }],
    })
    searchVideos.mockResolvedValueOnce(previous)
    expect(await store.search()).toBe(true)
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    store.patchDraft({ query: 'новая', language: 'en' })
    const action = store.search()
    expect(store.response).toBe(previous)
    expect(store.response?.applied.query).toBe('первая')
    expect(store.pending?.request.query).toBe('новая')
    expect(store.hasDraftChanges).toBe(true)
    expect(store.error).toBeNull()
    const failure = networkError()
    task.reject(failure)
    expect(await action).toBe(false)
    expect(store.response).toBe(previous)
    expect(store.response?.videos[0]?.id).toBe('old')
    expect(store.error).toBe(failure)
    expect(store.canRetry).toBe(true)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(searchVideos).toHaveBeenCalledTimes(2)
  })
})

describe('explicit refresh and retry', () => {
  it('refreshes old applied filters and asks the backend for a new UTC lower boundary, not the draft', async () => {
    const { store, factory, searchVideos } = harness()
    const applied: SearchVideosRequest = {
      query: 'применённая', limit: 50, period: 'month', relevance_language: 'ru',
      duration_ranges: ['over_60m', 'up_to_3m'], min_subscribers: 0, max_subscribers: 50,
      min_views: 0, max_views: null, published_after: '2026-01-01T12:00:00Z',
      published_before: '2027-01-01T00:00:00Z', page_token: 'old-page',
    }
    const previous = responseFor(applied, { videos: [{ id: 'old', title: 'Старое видео' }] })
    expect(await store.search()).toBe(true)
    // Seed an API-only applied snapshot; the editable form cannot submit these bounds.
    store.response = previous
    store.patchDraft({ query: 'неприменённая', language: 'zh', minSubscribers: '-1', maxSubscribers: '1e3', period: 'year', durationRanges: ['3_to_10m'] })
    const draft = { ...store.draft, durationRanges: [...store.draft.durationRanges] }
    const request: SearchVideosRequest = {
      query: 'применённая', limit: 50, period: 'month', relevance_language: 'ru',
      duration_ranges: ['over_60m', 'up_to_3m'], min_subscribers: 0, max_subscribers: 50,
      min_views: 0, max_views: null, published_before: '2027-01-01T00:00:00Z',
    }
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    const action = store.refresh()
    expect(store.pending).toEqual({ kind: 'refresh', request })
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(store.response).toBe(previous)
    expect(store.response?.applied.published_after).toBe('2026-01-01T12:00:00Z')
    expect(store.draft).toEqual(draft)
    expect(await store.search()).toBe(false)
    expect(await store.refresh()).toBe(false)
    const updated = responseFor(request, { applied: { ...request, published_after: '2026-01-02T12:00:00Z' }, fetched_at: '2026-02-02T12:00:00Z' })
    task.resolve(updated)
    expect(await action).toBe(true)
    expect(store.response).toBe(updated)
    expect(store.response?.applied.published_after).toBe('2026-01-02T12:00:00Z')
    expect(store.draft).toEqual(draft)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(searchVideos).toHaveBeenCalledTimes(2)
  })

  it('retries the exact failed search snapshot even after edits or adapter request mutation', async () => {
    const { store, factory, searchVideos } = harness()
    searchVideos.mockRejectedValueOnce(networkError())
    store.patchDraft({ query: ' первая ', language: 'zh-Hans', minSubscribers: '0', period: 'week', durationRanges: ['over_60m'] })
    const request: SearchVideosRequest = {
      query: 'первая', limit: 50, period: 'week', duration_ranges: ['over_60m'], relevance_language: 'zh-Hans', min_subscribers: 0,
    }
    expect(await store.search()).toBe(false)
    expect(store.canRetry).toBe(true)
    store.patchDraft({ query: 'другая', language: 'ru', minSubscribers: '100', period: 'all', durationRanges: ['up_to_3m'] })
    const draft = { ...store.draft, durationRanges: [...store.draft.durationRanges] }
    searchVideos.mock.calls[0]?.[0].duration_ranges?.push('3_to_10m')
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    const retry = store.retry()
    expect(store.pending).toEqual({ kind: 'search', request })
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(store.error).toBeNull()
    expect(store.canRetry).toBe(false)
    expect(store.draft).toEqual(draft)
    expect(await store.retry()).toBe(false)
    task.resolve(responseFor(request, { applied: { ...request, published_after: '2026-01-25T12:00:00Z' } }))
    expect(await retry).toBe(true)
    expect(store.draft).toEqual(draft)
    expect(store.response?.applied.query).toBe('первая')
    expect(store.hasDraftChanges).toBe(true)
    expect(store.canRetry).toBe(false)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('retains an old applied boundary on refresh failure and retries only that refresh snapshot', async () => {
    const { store, factory, searchVideos } = harness()
    const previous = responseFor({
      query: 'тема', limit: 50, period: 'day', duration_ranges: ['up_to_3m'],
      published_after: '2026-01-31T12:00:00Z', published_before: null, page_token: null,
    })
    store.patchDraft({ query: 'тема', period: 'day', durationRanges: ['up_to_3m'] })
    searchVideos.mockResolvedValueOnce(previous).mockRejectedValueOnce(networkError())
    expect(await store.search()).toBe(true)
    store.patchDraft({ query: 'черновик', period: 'year' })
    expect(await store.refresh()).toBe(false)
    expect(store.response).toBe(previous)
    expect(store.response?.applied.published_after).toBe('2026-01-31T12:00:00Z')
    expect(store.canRetry).toBe(true)
    store.patchDraft({ query: 'ещё новый черновик', language: 'zh-Hant' })
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    const retry = store.retry()
    const request: SearchVideosRequest = { query: 'тема', limit: 50, period: 'day', duration_ranges: ['up_to_3m'], published_before: null }
    expect(store.pending).toEqual({ kind: 'refresh', request })
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(searchVideos.mock.calls[2]?.[0]).toEqual(request)
    task.resolve(responseFor(request, { applied: { ...request, published_after: '2026-02-01T12:00:00Z' } }))
    expect(await retry).toBe(true)
    expect(store.draft.query).toBe('ещё новый черновик')
    expect(store.draft.language).toBe('zh-Hant')
    expect(store.response?.applied.published_after).toBe('2026-02-01T12:00:00Z')
    expect(factory).toHaveBeenCalledTimes(3)
    expect(searchVideos).toHaveBeenCalledTimes(3)
  })

  it.each([
    { code: 'validation_error', status: 422 },
    { code: 'quota_exceeded', status: 429 },
    { code: 'source_not_configured', status: 503 },
  ])('allows an exact explicit retry of $code despite retryable:false, without automatic retries', async ({ code, status }) => {
    const { store, factory, searchVideos } = harness()
    const failure = new ApiError('Не удалось выполнить запрос.', { code, status, retryable: false })
    const request: SearchVideosRequest = {
      query: 'прежняя', limit: 50, period: 'all', duration_ranges: ['over_60m'], min_subscribers: 0,
    }
    store.patchDraft({ query: 'прежняя', minSubscribers: '0', durationRanges: ['over_60m'] })
    searchVideos.mockRejectedValueOnce(failure)
    expect(await store.search()).toBe(false)
    expect(store.error).toBe(failure)
    expect(store.error?.retryable).toBe(false)
    expect(store.canRetry).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(searchVideos).toHaveBeenCalledTimes(1)
    store.patchDraft({ query: 'неприменённая', minSubscribers: '100', durationRanges: ['up_to_3m'] })
    expect(await store.retry()).toBe(true)
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(store.draft.query).toBe('неприменённая')
    expect(store.draft.minSubscribers).toBe('100')
    expect(factory).toHaveBeenCalledTimes(2)
    expect(searchVideos).toHaveBeenCalledTimes(2)
    expect(store.canRetry).toBe(false)
  })

  it('creates a fresh client on explicit retry after configuration recovers, retaining the failed request', async () => {
    const { store, factory, searchVideos } = harness()
    const failure = new ApiError('Некорректный адрес API.', { code: 'invalid_base_url', retryable: false })
    factory.mockImplementationOnce(() => { throw failure })
    store.patchDraft({ query: 'прежняя', minSubscribers: '0' })
    expect(await store.search()).toBe(false)
    expect(store.error).toBe(failure)
    expect(store.error?.retryable).toBe(false)
    expect(store.canRetry).toBe(true)
    expect(searchVideos).not.toHaveBeenCalled()
    store.patchDraft({ query: 'новый черновик', minSubscribers: '100' })
    expect(await store.retry()).toBe(true)
    expect(searchVideos.mock.calls[0]?.[0]).toEqual({ query: 'прежняя', limit: 50, period: 'all', duration_ranges: [], min_subscribers: 0 })
    expect(store.draft.query).toBe('новый черновик')
    expect(store.error).toBeNull()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })
})

describe('cancellation and stale adapters that ignore abort', () => {
  it('aborts and discards a cancelled completion without creating an error', async () => {
    const { store, searchVideos } = harness()
    const previous = responseFor({ query: 'прежняя' })
    store.patchDraft({ query: 'прежняя' })
    searchVideos.mockResolvedValueOnce(previous)
    expect(await store.search()).toBe(true)
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    store.patchDraft({ query: 'отменённая' })
    const action = store.search()
    const signal = searchVideos.mock.calls[1]?.[1]?.signal
    store.cancel()
    expect(signal?.aborted).toBe(true)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
    expect(store.error).toBeNull()
    expect(store.canRetry).toBe(false)
    task.resolve(responseFor({ query: 'отменённая' }))
    expect(await action).toBe(false)
    expect(store.response).toBe(previous)
    expect(store.error).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('guards stale %s and finally while a newer request is pending', async completion => {
    const { store, searchVideos } = harness()
    const previous = responseFor({ query: 'прежняя' })
    store.patchDraft({ query: 'прежняя' })
    searchVideos.mockResolvedValueOnce(previous)
    expect(await store.search()).toBe(true)
    const older = deferred<SearchVideosResponse>()
    const newer = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    store.patchDraft({ query: 'старая' })
    const oldAction = store.search()
    store.cancel()
    store.patchDraft({ query: 'новая' })
    const newAction = store.search()
    const newPending = store.pending
    const newSignal = searchVideos.mock.calls[2]?.[1]?.signal
    if (completion === 'resolve') older.resolve(responseFor({ query: 'старая' }))
    else older.reject(new Error('discard-sentinel https://invalid.example.test/debug'))
    expect(await oldAction).toBe(false)
    expect(store.pending).toBe(newPending)
    expect(store.pending?.request.query).toBe('новая')
    expect(store.busy).toBe(true)
    expect(newSignal?.aborted).toBe(false)
    expect(store.response).toBe(previous)
    expect(store.error).toBeNull()
    const latest = responseFor({ query: 'новая' })
    newer.resolve(latest)
    expect(await newAction).toBe(true)
    expect(store.response).toBe(latest)
    expect(store.busy).toBe(false)
  })

  it('does not overwrite a newer success when an ignored old response arrives later', async () => {
    const { store, searchVideos } = harness()
    const older = deferred<SearchVideosResponse>()
    const newer = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    store.patchDraft({ query: 'старая' })
    const oldAction = store.search()
    store.cancel()
    store.patchDraft({ query: 'новая' })
    const newAction = store.search()
    const latest = responseFor({ query: 'новая' })
    newer.resolve(latest)
    expect(await newAction).toBe(true)
    older.resolve(responseFor({ query: 'старая' }))
    expect(await oldAction).toBe(false)
    expect(store.response).toBe(latest)
    expect(store.pending).toBeNull()
    expect(store.error).toBeNull()
    expect(store.busy).toBe(false)
  })

  it('keeps the newer controller cancellable after the stale finally executes', async () => {
    const { store, searchVideos } = harness()
    const older = deferred<SearchVideosResponse>()
    const newer = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const oldAction = store.search()
    store.cancel()
    const newAction = store.search()
    const newSignal = searchVideos.mock.calls[1]?.[1]?.signal
    older.resolve(responseFor())
    expect(await oldAction).toBe(false)
    expect(store.busy).toBe(true)
    store.cancel()
    expect(newSignal?.aborted).toBe(true)
    newer.resolve(responseFor())
    expect(await newAction).toBe(false)
    expect(store.response).toBeNull()
    expect(store.pending).toBeNull()
    expect(store.error).toBeNull()
  })

  it('does not turn an AbortError from the adapter into a retryable failure', async () => {
    const { store, searchVideos } = harness()
    searchVideos.mockRejectedValueOnce(new DOMException('discard-sentinel', 'AbortError'))
    expect(await store.search()).toBe(false)
    expect(store.error).toBeNull()
    expect(store.canRetry).toBe(false)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
  })
})

describe('safe failures and backend field mapping', () => {
  it.each(['configuration', 'fetch'] as const)('turns unknown %s exceptions into a safe Russian ApiError', async source => {
    const { store, factory, searchVideos } = harness()
    const exception = new TypeError('discard-sentinel https://invalid.example.test/internal', {
      cause: new Error('discard-sentinel transport cause'),
    })
    if (source === 'configuration') factory.mockImplementationOnce(() => { throw exception })
    else searchVideos.mockRejectedValueOnce(exception)
    expect(await store.search()).toBe(false)
    expect(store.error).toBeInstanceOf(ApiError)
    expect(store.error).toMatchObject({
      name: 'ApiError', code: 'unexpected_error', status: null, retryable: true, fields: [],
      message: 'Не удалось выполнить поиск. Попробуйте ещё раз.',
    })
    expect(store.error).not.toHaveProperty('cause')
    expect(store.error?.message).not.toContain('discard-sentinel')
    expect(store.error?.message).not.toContain('https:')
    expect(store.pending).toBeNull()
    expect(store.canRetry).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(searchVideos).toHaveBeenCalledTimes(source === 'configuration' ? 0 : 1)
  })

  it('maps only controlled backend 422 body locations to unchanged editable criteria', async () => {
    const { store, searchVideos } = harness()
    const failure = new ApiError('Некоторые поля запроса заполнены некорректно.', {
      code: 'validation_error', status: 422, fields: [
        { loc: ['body', 'query'], type: 'value_error', message: 'Проверьте тему.' },
        { loc: ['body', 'relevance_language'], type: 'value_error', message: 'Проверьте язык.' },
        { loc: ['body', 'min_subscribers'], type: 'value_error', message: 'Проверьте минимум.' },
        { loc: ['body', 'max_subscribers'], type: 'value_error', message: 'Проверьте максимум.' },
        { loc: ['body', 'period'], type: 'value_error', message: 'Проверьте период.' },
        { loc: ['body', 'duration_ranges', 0], type: 'literal_error', message: 'Проверьте длительность.' },
        { loc: ['body', 'duration_ranges', 1], type: 'literal_error', message: 'Второе сообщение не заменяет первое.' },
        { loc: ['body', 'min_views'], type: 'value_error', message: 'Не поле формы.' },
        { loc: ['query', 'query'], type: 'value_error', message: 'Не тело запроса.' },
        { loc: ['body', 'query', 'nested'], type: 'value_error', message: 'Неизвестное вложение.' },
        { loc: ['body'], type: 'value_error', message: 'Ошибка всего запроса.' },
      ],
    })
    searchVideos.mockRejectedValueOnce(failure)
    expect(await store.search()).toBe(false)
    expect(store.fieldErrors).toEqual({
      query: 'Проверьте тему.', language: 'Проверьте язык.', minSubscribers: 'Проверьте минимум.',
      maxSubscribers: 'Проверьте максимум.', period: 'Проверьте период.', durationRanges: 'Проверьте длительность.',
    })
    expect(store.error).toBe(failure)
    expect(store.canRetry).toBe(true)
  })

  it.each(['search', 'refresh'] as const)('does not label an edited draft with stale %s validation errors', async kind => {
    const { store, searchVideos } = harness()
    if (kind === 'refresh') expect(await store.search()).toBe(true)
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    const action = kind === 'search' ? store.search() : store.refresh()
    store.patchDraft({ query: 'новая тема' })
    const failure = new ApiError('Проверьте запрос.', {
      code: 'validation_error', status: 422,
      fields: [{ loc: ['body', 'query'], type: 'value_error', message: 'Проверьте прежнюю тему.' }],
    })
    task.reject(failure)
    expect(await action).toBe(false)
    expect(store.fieldErrors).toEqual({})
    expect(store.draft.query).toBe('новая тема')
    expect(store.error).toBe(failure)
  })

  it.each([
    { label: 'null', payload: null },
    { label: 'empty object', payload: {} },
    { label: 'missing query', payload: { ...responseFor(), query: undefined } },
    { label: 'missing applied', payload: { ...responseFor(), applied: undefined } },
    { label: 'non-object applied', payload: { ...responseFor(), applied: [] } },
    { label: 'non-string applied query', payload: { ...responseFor(), applied: { query: 1 } } },
    { label: 'non-array applied ranges', payload: { ...responseFor(), applied: { duration_ranges: 'up_to_3m' } } },
    { label: 'null applied ranges', payload: { ...responseFor(), applied: { duration_ranges: null } } },
    { label: 'missing videos', payload: { ...responseFor(), videos: undefined } },
    { label: 'non-array videos', payload: { ...responseFor(), videos: {} } },
    { label: 'missing fetched_at', payload: { ...responseFor(), fetched_at: undefined } },
    { label: 'missing items_scanned', payload: { ...responseFor(), items_scanned: undefined } },
    { label: 'missing matched_count', payload: { ...responseFor(), matched_count: undefined } },
    { label: 'missing quota', payload: { ...responseFor(), quota_used_estimate: undefined } },
    { label: 'non-numeric count', payload: { ...responseFor(), matched_count: '0' } },
    { label: 'non-finite count', payload: { ...responseFor(), items_scanned: NaN } },
  ])('rejects a malformed envelope ($label), preserving earlier success instead of faking an empty result', async ({ payload }) => {
    const { store, searchVideos } = harness()
    const previous = responseFor({ query: 'прежняя' }, { videos: [{ id: 'old', title: 'Старое видео' }] })
    store.patchDraft({ query: 'прежняя' })
    searchVideos.mockResolvedValueOnce(previous).mockResolvedValueOnce(payload as SearchVideosResponse)
    expect(await store.search()).toBe(true)
    expect(await store.search()).toBe(false)
    expect(store.response).toBe(previous)
    expect(store.error).toBeInstanceOf(ApiError)
    expect(store.error).toMatchObject({ code: 'invalid_response', retryable: true, message: 'Сервис вернул некорректный ответ.' })
    expect(store.canRetry).toBe(true)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
    expect(searchVideos).toHaveBeenCalledTimes(2)
  })

  it('imports and constructs the default store without reading bad configuration eagerly or fetching', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'not-a-public-origin-discard-sentinel')
    const fetchMock = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const module = await import('./search')
    const store = module.useSearchStore(createPinia())
    store.patchDraft({ query: 'тема', language: 'ru' })
    store.resetFilters()
    expect(store.error).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await store.search()).toBe(false)
    expect(store.error).toMatchObject({ name: 'ApiError', code: 'invalid_base_url', retryable: false, status: null })
    expect(store.error?.message).not.toContain('discard-sentinel')
    expect(store.error).not.toHaveProperty('cause')
    expect(store.canRetry).toBe(true)
    expect(store.pending).toBeNull()
    expect(await store.retry()).toBe(false)
    expect(store.error?.retryable).toBe(false)
    expect(store.canRetry).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

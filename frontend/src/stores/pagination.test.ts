// @vitest-environment node
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import type { ApiClient, SearchVideosRequest, SearchVideosResponse } from '../api'
import type { SortMode } from '../features/search/results'
import { createSearchStore } from './search'

function page(request: SearchVideosRequest, overrides: Partial<SearchVideosResponse> = {}): SearchVideosResponse {
  return { query: request.query ?? '', applied: { ...request }, videos: [], fetched_at: '2026-02-01T00:00:00Z',
    items_scanned: 50, matched_count: 0, quota_used_estimate: 2, ...overrides }
}
function harness() {
  const searchVideos = vi.fn<ApiClient['searchVideos']>().mockImplementation(async request => page(request))
  const api = { searchVideos, getChannel: vi.fn<ApiClient['getChannel']>(), getVideo: vi.fn<ApiClient['getVideo']>() }
  const factory = vi.fn(() => api)
  return { store: createSearchStore(factory)(createPinia()), searchVideos, factory, api }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function firstPage(h: ReturnType<typeof harness>, next = 'one') {
  h.store.patchDraft({ query: 'original', period: 'month', language: 'ru', durationRanges: ['up_to_3m'], minSubscribers: '0' })
  h.searchVideos.mockImplementationOnce(async request => page(request, {
    applied: { ...request, published_after: '2026-01-01T00:00:00Z' },
    videos: [{ id: 'a', title: 'first', view_count: null }, { id: 'a', title: 'duplicate', view_count: 50 }],
    matched_count: 2, next_page_token: next,
  }))
  expect(await h.store.search()).toBe(true)
  // API-only bounds can be restored from a session, but cannot be submitted by the form.
  h.store.response = { ...h.store.response!, applied: { ...h.store.response!.applied,
    published_before: '2026-02-01T00:00:00Z', min_views: 0 } }
}

describe('explicit pagination', () => {
  it('starts empty; frozen applied wins over dirty draft and each explicit action calls once', async () => {
    const h = harness()
    expect(h.store.sourceVideos).toEqual([])
    expect(h.store.lastAddedCount).toBeNull()
    expect(h.store.pageCount).toBe(0)
    expect(h.store.canLoadMore).toBe(false)
    expect(await h.store.loadMore()).toBe(false)
    await firstPage(h)
    const original = h.store.response!
    const source = h.store.sourceVideos
    expect(source).toEqual([original.videos[0]])
    h.store.patchDraft({ query: 'dirty', period: 'year', minSubscribers: '-1', language: 'en' })
    h.searchVideos.mockImplementationOnce(async request => page(request, {
      videos: [{ id: 'a', title: 'replacement', view_count: 999, channel_title: 'new' }, { id: 'b', title: 'second' }],
      matched_count: 2, next_page_token: 'two', fetched_at: '2026-02-02T00:00:00Z',
    }))
    expect(await h.store.loadMore()).toBe(true)
    expect(h.searchVideos.mock.calls[1]?.[0]).toEqual({ ...original.applied, page_token: 'one' })
    expect(h.searchVideos).toHaveBeenCalledTimes(2)
    expect(h.store.response?.applied).toBe(original.applied)
    expect(h.store.response?.applied.page_token).toBeUndefined()
    expect(h.store.response?.fetched_at).toBe('2026-02-02T00:00:00Z')
    expect(h.store.response?.videos[0]?.title).toBe('replacement')
    expect(h.store.sourceVideos).toEqual([source[0], { id: 'b', title: 'second' }])
    expect(h.store.sourceVideos[0]).toBe(source[0])
    expect(source).toHaveLength(1)
    expect(h.store.lastAddedCount).toBe(1)
    expect(h.store.pageCount).toBe(2)
    expect(h.store.totalItemsScanned).toBe(100)
    expect(h.store.totalQuotaUsedEstimate).toBe(4)
    expect(h.api.getChannel).not.toHaveBeenCalled()
  })

  it('zero-match and duplicate-only pages advance without loops; null token ends pagination', async () => {
    const h = harness()
    await firstPage(h)
    h.searchVideos.mockImplementationOnce(async request => page(request, { next_page_token: 'two' }))
    expect(await h.store.loadMore()).toBe(true)
    expect(h.store.lastAddedCount).toBe(0)
    expect(h.store.canLoadMore).toBe(true)
    expect(h.searchVideos).toHaveBeenCalledTimes(2)
    h.searchVideos.mockImplementationOnce(async request => page(request, { videos: [{ id: 'a', title: 'newer' }], next_page_token: null }))
    expect(await h.store.loadMore()).toBe(true)
    expect(h.store.lastAddedCount).toBe(0)
    expect(h.store.pageCount).toBe(3)
    expect(h.store.canLoadMore).toBe(false)
    expect(h.store.paginationStopped).toBe(false)
    expect(await h.store.loadMore()).toBe(false)
    expect(h.searchVideos).toHaveBeenCalledTimes(3)
  })

  it.each(['one', 'two'])('accepts the bounded page once then stops on repeated token %s', async next => {
    const h = harness()
    await firstPage(h)
    h.searchVideos.mockImplementationOnce(async request => page(request, { next_page_token: 'two' }))
    await h.store.loadMore()
    h.searchVideos.mockImplementationOnce(async request => page(request, { videos: [{ id: 'b', title: 'accepted' }], next_page_token: next }))
    expect(await h.store.loadMore()).toBe(true)
    expect(h.store.paginationStopped).toBe(true)
    expect(h.store.canLoadMore).toBe(false)
    expect(h.store.error).toBeNull()
    expect(h.store.sourceVideos.map(video => video.id)).toEqual(['a', 'b'])
    expect(await h.store.loadMore()).toBe(false)
    expect(h.searchVideos).toHaveBeenCalledTimes(3)
  })

  it('retries captured failed more exactly, preserving aggregate and not consuming its token', async () => {
    const h = harness()
    await firstPage(h)
    const original = h.store.response
    const source = h.store.sourceVideos
    h.searchVideos.mockRejectedValueOnce(new ApiError('Ошибка', { code: 'validation_error', status: 422, retryable: false,
      fields: [{ loc: ['body', 'query'], message: 'not draft', type: 'value_error' }] }))
    expect(await h.store.loadMore()).toBe(false)
    const request = { ...h.searchVideos.mock.calls[1]![0], duration_ranges: ['up_to_3m'] }
    h.searchVideos.mock.calls[1]![0].duration_ranges!.push('over_60m')
    h.store.patchDraft({ query: 'dirty', period: 'all' })
    expect(h.store.response).toBe(original)
    expect(h.store.sourceVideos).toBe(source)
    expect(h.store.pageCount).toBe(1)
    expect(h.store.canRetry).toBe(true)
    expect(h.store.canLoadMore).toBe(true)
    expect(h.store.fieldErrors).toEqual({})
    h.searchVideos.mockImplementationOnce(async req => page(req, { next_page_token: 'two' }))
    expect(await h.store.retry()).toBe(true)
    expect(h.searchVideos.mock.calls[2]?.[0]).toEqual(request)
    expect(h.store.pageCount).toBe(2)
    expect(h.store.paginationStopped).toBe(false)
  })

  it.each([42, '', 'bad token', '\u0000bad', 'x'.repeat(2049)])('rejects malformed next token %# without changing earlier state', async token => {
    const h = harness()
    await firstPage(h)
    const original = h.store.response
    const source = h.store.sourceVideos
    h.searchVideos.mockImplementationOnce(async request => page(request, { next_page_token: token as string }))
    expect(await h.store.loadMore()).toBe(false)
    expect(h.store.response).toBe(original)
    expect(h.store.sourceVideos).toBe(source)
    expect(h.store.error?.code).toBe('invalid_response')
    expect(h.store.pageCount).toBe(1)
    expect(h.searchVideos).toHaveBeenCalledTimes(2)
  })

  it.each([
    { query: 'other' }, { period: 'all' }, { relevance_language: 'en' }, { min_subscribers: 1 },
    { max_subscribers: 100 }, { duration_ranges: [] }, { published_after: '2025-01-01T00:00:00Z' },
    { published_before: null }, { limit: 1 }, { min_views: null }, { max_views: 500 },
  ] satisfies Partial<SearchVideosRequest>[])('rejects mismatched full applied criteria %#', async changed => {
    const h = harness()
    await firstPage(h)
    const original = h.store.response
    h.searchVideos.mockImplementationOnce(async request => page(request, { applied: { ...request, ...changed }, next_page_token: 'two' }))
    expect(await h.store.loadMore()).toBe(false)
    expect(h.store.response).toBe(original)
    expect(h.store.error?.code).toBe('invalid_response')
    expect(h.store.pageCount).toBe(1)
    expect(h.store.totalItemsScanned).toBe(50)
    expect(h.store.lastAddedCount).toBe(1)
  })

  it('accepts backend default normalization and ignores only the pagination token', async () => {
    const h = harness()
    await firstPage(h)
    h.searchVideos.mockImplementationOnce(async request => page(request, {
      applied: { ...request, page_token: null, max_views: null, max_subscribers: null },
      next_page_token: 'x'.repeat(2048),
    }))
    expect(await h.store.loadMore()).toBe(true)
    expect(h.store.canLoadMore).toBe(true)
  })

  it('rejects a malformed first-page continuation without replacing the session', async () => {
    const h = harness()
    await firstPage(h)
    const response = h.store.response
    const source = h.store.sourceVideos
    h.searchVideos.mockImplementationOnce(async request => page(request, { next_page_token: 'bad token' }))
    expect(await h.store.search()).toBe(false)
    expect(h.store.response).toBe(response)
    expect(h.store.sourceVideos).toBe(source)
    expect(h.store.canLoadMore).toBe(true)
  })

  it('refuses relative pagination without a frozen date before creating a client', async () => {
    const h = harness()
    h.store.patchDraft({ period: 'month' })
    h.searchVideos.mockImplementationOnce(async request => page(request, { next_page_token: 'one' }))
    await h.store.search()
    expect(await h.store.loadMore()).toBe(false)
    expect(h.store.error?.code).toBe('invalid_response')
    expect(h.factory).toHaveBeenCalledTimes(1)
  })

  it('sorts without network, rejects unsupported modes and restores original source order', async () => {
    const h = harness()
    await firstPage(h)
    const source = h.store.sourceVideos
    for (const mode of ['views', 'date', 'ratio', 'original'] as const) h.store.setSort(mode)
    h.store.setSort('unsupported' as SortMode)
    expect(h.store.sortMode).toBe('original')
    expect(h.store.sortedVideos).toEqual(source)
    expect(h.store.sourceVideos).toBe(source)
    expect(h.factory).toHaveBeenCalledTimes(1)
  })

  it('reset changes draft only; successful refresh/search replace aggregate and reset token history, preserving sort', async () => {
    const h = harness()
    await firstPage(h)
    h.store.setSort('views')
    h.searchVideos.mockImplementationOnce(async request => page(request, { next_page_token: 'one' }))
    await h.store.loadMore()
    expect(h.store.paginationStopped).toBe(true)
    const source = h.store.sourceVideos
    h.store.resetFilters()
    expect(h.store.sourceVideos).toBe(source)
    h.searchVideos.mockImplementationOnce(async request => page(request, { applied: { ...request, published_after: '2026-01-02T00:00:00Z' },
      videos: [{ id: 'c', title: 'fresh' }], items_scanned: 1, quota_used_estimate: 0, next_page_token: 'one' }))
    expect(await h.store.refresh()).toBe(true)
    expect(h.store.sourceVideos.map(video => video.id)).toEqual(['c'])
    expect(h.store.pageCount).toBe(1)
    expect(h.store.totalItemsScanned).toBe(1)
    expect(h.store.totalQuotaUsedEstimate).toBe(0)
    expect(h.store.canLoadMore).toBe(true)
    expect(h.store.paginationStopped).toBe(false)
    expect(h.store.sortMode).toBe('views')
    expect(await h.store.search()).toBe(true)
    expect(h.store.sourceVideos).toEqual([])
    expect(h.store.lastAddedCount).toBe(0)
    expect(h.store.pageCount).toBe(1)
    expect(h.store.sortMode).toBe('views')
  })

  it.each(['resolve', 'reject'] as const)('discards cancelled more %s and its finally during a newer more action', async kind => {
    const h = harness()
    await firstPage(h)
    const old = deferred<SearchVideosResponse>()
    const newer = deferred<SearchVideosResponse>()
    h.searchVideos.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const first = h.store.loadMore()
    const oldSignal = h.searchVideos.mock.calls[1]?.[1]?.signal
    expect(h.store.pending?.kind).toBe('more')
    expect(h.store.canLoadMore).toBe(false)
    expect(await h.store.loadMore()).toBe(false)
    expect(await h.store.search()).toBe(false)
    expect(await h.store.refresh()).toBe(false)
    h.store.cancel()
    expect(oldSignal?.aborted).toBe(true)
    const second = h.store.loadMore()
    const pending = h.store.pending
    if (kind === 'resolve') old.resolve(page(h.searchVideos.mock.calls[1]![0], { videos: [{ id: 'stale', title: 'stale' }] }))
    else old.reject(new Error('stale'))
    expect(await first).toBe(false)
    expect(h.store.pending).toBe(pending)
    expect(h.store.busy).toBe(true)
    expect(h.store.pageCount).toBe(1)
    newer.resolve(page(h.searchVideos.mock.calls[2]![0], { videos: [{ id: 'b', title: 'new' }], next_page_token: 'two' }))
    expect(await second).toBe(true)
    expect(h.store.sourceVideos.map(video => video.id)).toEqual(['a', 'b'])
    expect(h.store.pageCount).toBe(2)
    expect(h.store.canLoadMore).toBe(true)
    expect(h.store.error).toBeNull()
  })

  it('ignores cancelled more after a replacement search succeeds', async () => {
    const h = harness()
    await firstPage(h)
    const old = deferred<SearchVideosResponse>()
    h.searchVideos.mockReturnValueOnce(old.promise)
    const more = h.store.loadMore()
    h.store.cancel()
    h.store.patchDraft({ query: 'new', period: 'all' })
    expect(await h.store.search()).toBe(true)
    const response = h.store.response
    old.resolve(page(h.searchVideos.mock.calls[1]![0], { videos: [{ id: 'stale', title: 'stale' }] }))
    expect(await more).toBe(false)
    expect(h.store.response).toBe(response)
    expect(h.store.sourceVideos).toEqual([])
    expect(h.store.pageCount).toBe(1)
  })
})

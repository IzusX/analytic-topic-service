import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, SearchVideosRequest, SearchVideosResponse } from '../api'
import { createSearchStore } from './search'
import { createSessionCacheStore, SESSION_CACHE_KEY } from './sessionCache'

function page(request: SearchVideosRequest): SearchVideosResponse {
  return { query: request.query ?? '', applied: { ...request }, videos: [{ id: 'good', title: 'Good' }],
    fetched_at: '2026-01-01', items_scanned: 1, matched_count: 1, quota_used_estimate: 1, next_page_token: 'next' }
}
function setup() {
  const data = new Map<string, string>()
  const disk = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } as Storage
  const pinia = createPinia()
  const cache = createSessionCacheStore(() => disk)(pinia)
  const searchVideos = vi.fn<ApiClient['searchVideos']>().mockImplementation(async request => page(request))
  const api: ApiClient = { searchVideos, getChannel: vi.fn(), getVideo: vi.fn() }
  const search = createSearchStore(() => api, () => cache)(pinia)
  return { search, searchVideos, disk }
}

describe('search live DTO and identity hardening', () => {
  it.each(['search', 'refresh', 'more'] as const)('rejects malformed consumed video fields on %s before any state/cache commit', async kind => {
    for (const field of ['published_at', 'view_count', 'channel_title', 'channel_subscriber_count_hidden']) {
      const { search, searchVideos, disk } = setup()
      await search.search()
      const previous = search.response
      const persisted = disk.getItem(SESSION_CACHE_KEY)
      searchVideos.mockImplementationOnce(async request => ({ ...page(request),
        videos: [{ id: 'bad', title: 'Bad', [field]: { toString: null } }] } as unknown as SearchVideosResponse))
      if (kind === 'search') search.patchDraft({ query: 'new' })
      const before = disk.getItem(SESSION_CACHE_KEY)
      expect(await (kind === 'more' ? search.loadMore() : kind === 'refresh' ? search.refresh() : search.search())).toBe(false)
      expect(search.error?.code).toBe('invalid_response')
      expect(search.response).toBe(previous)
      expect(JSON.parse(disk.getItem(SESSION_CACHE_KEY)!).searches).toEqual(JSON.parse(before!).searches)
      search.setSort('date')
      expect(search.sortedVideos.map(video => video.id)).toEqual(['good'])
      expect(createSessionCacheStore(() => disk)(createPinia()).activeSearchKey).toBe(JSON.parse(persisted!).activeSearchKey)
    }
  })

  it.each(['search', 'refresh'] as const)('rejects mismatched first-page %s identity and retains reloadable cache', async kind => {
    for (const mismatch of [{ query: 'other' }, { min_views: 2 }, { limit: 3 }, { period: 'week' as const }]) {
      const { search, searchVideos, disk } = setup()
      await search.search()
      const previous = search.response
      searchVideos.mockImplementationOnce(async request => ({ ...page(request), applied: { ...request, ...mismatch } }))
      if (kind === 'search') search.patchDraft({ query: 'new' })
      expect(await (kind === 'search' ? search.search() : search.refresh())).toBe(false)
      expect(search.error?.code).toBe('invalid_response')
      expect(search.response).toBe(previous)
      const restored = createSessionCacheStore(() => disk)(createPinia())
      expect(restored.activeSearchKey).not.toBeNull()
      expect(restored.persistenceWarning).toBeNull()
    }
  })

  it('rejects a wrong envelope query even when applied criteria match', async () => {
    const { search, searchVideos } = setup()
    searchVideos.mockImplementationOnce(async request => ({ ...page(request), query: 'wrong' }))
    expect(await search.search()).toBe(false)
    expect(search.error?.code).toBe('invalid_response')
    expect(search.response).toBeNull()
  })

  it('preserves an explicit all-period lower bound on refresh', async () => {
    const { search, searchVideos } = setup()
    await search.search()
    search.response = { ...search.response!, applied: { ...search.response!.applied, published_after: '2025-01-01T00:00:00Z' } }
    const previous = search.response
    searchVideos.mockImplementationOnce(async request => ({ ...page(request), applied: { ...request, published_after: '2026-01-01T00:00:00Z' } }))
    expect(await search.refresh()).toBe(false)
    expect(search.response).toBe(previous)
    expect(search.error?.code).toBe('invalid_response')
  })

  it('allows backend defaults and a newly frozen relative date, but preserves explicit bounds on continuation', async () => {
    const { search, searchVideos } = setup()
    search.patchDraft({ period: 'month' })
    searchVideos.mockImplementationOnce(async request => ({ ...page(request), applied: { ...request,
      relevance_language: null, min_views: null, published_after: '2025-12-01T00:00:00Z' } }))
    expect(await search.search()).toBe(true)
    searchVideos.mockImplementationOnce(async request => ({ ...page(request), applied: { ...request, published_after: 'changed' } }))
    expect(await search.loadMore()).toBe(false)
    searchVideos.mockImplementationOnce(async request => ({ ...page(request), applied: { ...request, published_after: '2026-01-01T00:00:00Z' } }))
    expect(await search.refresh()).toBe(true)
  })
})

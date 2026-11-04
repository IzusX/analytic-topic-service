import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, SearchVideosRequest, SearchVideosResponse } from '../api'
import { createSearchStore } from './search'
import { createSessionCacheStore, SESSION_CACHE_KEY } from './sessionCache'

function storage(): Storage {
  const data = new Map<string, string>()
  return { get length() { return data.size }, clear: () => data.clear(), key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}
function setup(disk: Storage) {
  const pinia = createPinia()
  const cache = createSessionCacheStore(() => disk)(pinia)
  const searchVideos = vi.fn<ApiClient['searchVideos']>().mockImplementation(async request => page(request))
  const api = { searchVideos, getChannel: vi.fn<ApiClient['getChannel']>(), getVideo: vi.fn<ApiClient['getVideo']>() }
  const search = createSearchStore(() => api, () => cache)(pinia)
  return { cache, search, searchVideos, api }
}
function page(request: SearchVideosRequest): SearchVideosResponse {
  return { query: request.query ?? '', applied: { ...request,
    ...(request.period === 'month' ? { published_after: request.published_after ?? '2026-01-01T00:00:00Z' } : {}) },
    videos: [{ id: request.page_token ? 'second' : 'first', title: request.query ?? '' }],
    fetched_at: '2026-02-01T00:00:00Z', next_page_token: request.page_token ? 'next2' : 'next1',
    items_scanned: 50, matched_count: 1, quota_used_estimate: 102, order: 'relevance' }
}

describe('search session integration', () => {
  it('restores dirty raw draft, aggregate pages, frozen date, sort, token history and origin without requests', async () => {
    const disk = storage()
    const first = setup(disk)
    first.search.patchDraft({ query: 'Music', period: 'month' })
    await first.search.search()
    await first.search.loadMore()
    first.search.setSort('views')
    first.search.patchDraft({ query: 'Unapplied', minSubscribers: 'invalid' })
    first.search.saveContext(824, 'first')
    const restored = setup(disk)
    expect(restored.search.draft.query).toBe('Unapplied')
    expect(restored.search.draft.minSubscribers).toBe('invalid')
    expect(restored.search.response?.applied.query).toBe('Music')
    expect(restored.search.response?.applied.published_after).toBe('2026-01-01T00:00:00Z')
    expect(restored.search.sourceVideos.map(video => video.id)).toEqual(['first', 'second'])
    expect(restored.search.pageCount).toBe(2)
    expect(restored.search.totalItemsScanned).toBe(100)
    expect(restored.search.sortMode).toBe('views')
    expect(restored.search.scrollY).toBe(824)
    expect(restored.search.sourceVideoId).toBe('first')
    expect(restored.search.hasDraftChanges).toBe(true)
    expect(restored.searchVideos).not.toHaveBeenCalled()
    await restored.search.loadMore()
    expect(restored.searchVideos).toHaveBeenCalledWith(expect.objectContaining({ query: 'Music', page_token: 'next2', published_after: '2026-01-01T00:00:00Z' }), expect.anything())
  })

  it('uses cached matching search including relative period, but explicit refresh calls API and preserves dirty draft', async () => {
    const { search, searchVideos } = setup(storage())
    search.patchDraft({ query: 'Music', period: 'month' })
    await search.search()
    await search.loadMore()
    search.setSort('date')
    search.patchDraft({ query: 'Other' })
    await search.search()
    search.patchDraft({ query: '  Music  ' })
    await search.search()
    expect(searchVideos).toHaveBeenCalledTimes(3)
    expect(search.sourceVideos).toHaveLength(2)
    expect(search.sortMode).toBe('date')
    search.patchDraft({ query: 'Dirty' })
    await search.refresh()
    expect(searchVideos).toHaveBeenCalledTimes(4)
    expect(searchVideos.mock.calls[3]?.[0]).not.toHaveProperty('published_after')
    expect(search.draft.query).toBe('Dirty')
    expect(search.sourceVideos).toHaveLength(1)
  })

  it('keeps failed refresh and retry out of storage, preserving last successful snapshot', async () => {
    const disk = storage()
    const { search, searchVideos } = setup(disk)
    await search.search()
    searchVideos.mockRejectedValueOnce(new Error('offline'))
    await search.refresh()
    expect(search.error).not.toBeNull()
    expect(search.canRetry).toBe(true)
    const reloaded = setup(disk)
    expect(reloaded.search.sourceVideos).toHaveLength(1)
    expect(reloaded.search.error).toBeNull()
    expect(reloaded.search.canRetry).toBe(false)
    expect(disk.getItem(SESSION_CACHE_KEY)).not.toContain('offline')
  })

  it('search remains functional when storage access throws', async () => {
    const disk = storage()
    disk.setItem = () => { throw new Error('denied') }
    const { search } = setup(disk)
    expect(await search.search()).toBe(true)
    expect(search.sourceVideos).toHaveLength(1)
    expect(search.persistenceWarning).toBeTruthy()
  })
})

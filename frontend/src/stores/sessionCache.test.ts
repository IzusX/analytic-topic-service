import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createEmptyDraft } from '../features/search/model'
import type { ChannelCardOut } from '../api'
import { channelCacheKey, createSessionCacheStore, searchCacheKey, SESSION_CACHE_KEY, SESSION_CACHE_MAX_BYTES } from './sessionCache'
import type { SearchSnapshot } from './sessionCache'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return { get length() { return data.size }, clear: () => data.clear(), key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}
function snapshot(title = 'Video'): SearchSnapshot {
  return { response: { query: 'Topic', applied: { query: 'Topic' }, videos: [{ id: 'v', title }], fetched_at: '2026-01-01',
    items_scanned: 1, matched_count: 1, quota_used_estimate: 100 }, sourceVideos: [{ id: 'v', title }], sortMode: 'original',
    pageCount: 1, totalItemsScanned: 1, totalQuotaUsedEstimate: 100, lastAddedCount: 1, paginationStopped: false,
    consumedTokens: [], scrollY: 350, sourceVideoId: null }
}
function analysis(id: string): ChannelCardOut {
  return { channel: { id, title: id }, sample: { selected_count: 0, metric_count: 0, uploads_scanned: 0,
    pages_scanned: 0, stop_reason: 'uploads_exhausted', target_reached: false, scan_limit_reached: false },
    metrics: { count: 0 }, summary: '', videos: [], fetched_at: '2026-01-01' }
}
beforeEach(() => setActivePinia(createPinia()))
describe('typed shared session cache', () => {
  it('round trips detached snapshots and a global invalid text draft', () => {
    const storage = memoryStorage()
    const cache = createSessionCacheStore(() => storage)()
    const value = snapshot()
    const key = searchCacheKey(value.response.applied)
    cache.putSearch(key, value)
    value.sourceVideos[0]!.title = 'mutated'
    cache.setDraft({ ...createEmptyDraft(), minSubscribers: 'invalid-1', query: '  Draft  ' })
    const read = cache.getSearch(key)!
    read.sourceVideos.length = 0
    expect(cache.getSearch(key)!.sourceVideos).toHaveLength(1)
    setActivePinia(createPinia())
    const hydrated = createSessionCacheStore(() => storage)()
    expect(hydrated.activeSearchKey).toBe(key)
    expect(hydrated.draft?.minSubscribers).toBe('invalid-1')
    expect(hydrated.getSearch(key)?.scrollY).toBe(350)
  })
  it('normalizes criteria without losing significant case/spacing or API bounds', () => {
    const request = { query: ' Topic  A ', period: 'month' as const, published_after: 'old', page_token: 'token' }
    expect(searchCacheKey(request)).toBe(searchCacheKey({ ...request, published_after: 'new', page_token: 'other' }))
    expect(searchCacheKey(request)).not.toBe(searchCacheKey({ ...request, query: 'topic A' }))
    for (const extra of [{ min_views: 1 }, { max_views: 9 }, { limit: 2 }, { published_before: 'end' }]) {
      expect(searchCacheKey(request)).not.toBe(searchCacheKey({ ...request, ...extra }))
    }
    expect(searchCacheKey({ period: 'all', published_after: 'a' })).not.toBe(searchCacheKey({ period: 'all', published_after: 'b' }))
  })
  it('enforces five searches and ten channels with touched LRU and protected active entries', () => {
    const cache = createSessionCacheStore()()
    for (let i = 0; i < 5; i++) cache.putSearch(String(i), snapshot())
    cache.getSearch('0')
    cache.putSearch('5', snapshot())
    expect(cache.getSearch('1')).toBeNull()
    expect(cache.getSearch('0')).not.toBeNull()
    for (let i = 0; i < 11; i++) cache.putChannel(channelCacheKey(String(i)), analysis(String(i)))
    expect(cache.getChannel(channelCacheKey('0'))).toBeNull()
    expect(cache.getChannel(channelCacheKey('10'))).not.toBeNull()
    expect(cache.getSearch('5')).not.toBeNull()
  })
  it('uses the total UTF-8 budget, evicts across kinds, retains oversized active data only in memory', () => {
    const storage = memoryStorage()
    const cache = createSessionCacheStore(() => storage)()
    cache.putSearch('old', snapshot('旧'.repeat(150_000)))
    cache.putChannel('channel', { ...analysis('channel'), summary: '文'.repeat(150_000) })
    cache.putSearch('active', snapshot('界'.repeat(400_000)))
    expect(new TextEncoder().encode(storage.getItem(SESSION_CACHE_KEY)!).byteLength).toBeLessThanOrEqual(SESSION_CACHE_MAX_BYTES)
    expect(cache.getSearch('old')).toBeNull()
    expect(cache.getChannel('channel')).not.toBeNull()
    cache.putSearch('huge', snapshot('界'.repeat(600_000)))
    expect(cache.getSearch('huge')).not.toBeNull()
    expect(cache.getChannel('channel')).not.toBeNull()
    expect(storage.getItem(SESSION_CACHE_KEY)).toBeNull()
    expect(cache.persistenceWarning).not.toBeNull()
  })
  it.each(['{broken', '{"version":1}', '{"version":2}'])('ignores corrupt/old storage: %s', text => {
    const storage = memoryStorage()
    storage.setItem(SESSION_CACHE_KEY, text)
    const cache = createSessionCacheStore(() => storage)()
    expect(cache.activeSearchKey).toBeNull()
    expect(cache.persistenceWarning).not.toBeNull()
    expect(storage.getItem(SESSION_CACHE_KEY)).toBeNull()
  })
  it.each(['view_count', 'channel_title', 'channel_subscriber_count_hidden', 'duration_seconds'])('rejects malformed video field %s', field => {
    const storage = memoryStorage()
    const cache = createSessionCacheStore(() => storage)()
    const value = snapshot()
    const key = searchCacheKey(value.response.applied)
    cache.putSearch(key, value)
    const data = JSON.parse(storage.getItem(SESSION_CACHE_KEY)!)
    data.searches[0].value.response.videos[0][field] = { unexpected: true }
    storage.setItem(SESSION_CACHE_KEY, JSON.stringify(data))
    setActivePinia(createPinia())
    const restored = createSessionCacheStore(() => storage)()
    expect(restored.getSearch(key)).toBeNull()
    expect(restored.persistenceWarning).not.toBeNull()
  })
  it.each(['search-key', 'channel-key', 'active-key', 'prototype'])('rejects mismatched or inherited storage identity: %s', corruption => {
    const storage = memoryStorage()
    const cache = createSessionCacheStore(() => storage)()
    const value = snapshot()
    cache.putSearch(searchCacheKey(value.response.applied), value)
    cache.putChannel(channelCacheKey('channel'), analysis('channel'))
    const data = JSON.parse(storage.getItem(SESSION_CACHE_KEY)!)
    if (corruption === 'search-key') data.searches[0].key = 'wrong'
    if (corruption === 'channel-key') data.channels[0].key = 'wrong'
    if (corruption === 'active-key') data.activeSearchKey = 'missing'
    if (corruption === 'prototype') Object.defineProperty(data.searches[0].value.response, '__proto__', { value: 'unexpected', enumerable: true })
    storage.setItem(SESSION_CACHE_KEY, JSON.stringify(data))
    setActivePinia(createPinia())
    const restored = createSessionCacheStore(() => storage)()
    expect(restored.activeSearchKey).toBeNull()
    expect(restored.persistenceWarning).not.toBeNull()
  })
  it('handles forbidden access, read/write/quota and remove failures without losing memory', () => {
    expect(createSessionCacheStore(() => { throw new Error('Forbidden') })().persistenceWarning).not.toBeNull()
    setActivePinia(createPinia())
    const storage = memoryStorage()
    storage.getItem = () => { throw new Error('Read blocked') }
    storage.setItem = () => { throw new Error('Quota') }
    storage.removeItem = () => { throw new Error('Remove blocked') }
    const cache = createSessionCacheStore(() => storage)()
    cache.putSearch('safe', snapshot())
    expect(cache.getSearch('safe')).not.toBeNull()
    expect(cache.persistenceWarning).not.toBeNull()
  })
})

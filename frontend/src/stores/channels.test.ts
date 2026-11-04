import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError } from '../api'
import type { ApiClient, ChannelCardOut } from '../api'
import { createChannelsStore } from './channels'
import { channelCacheKey, createSessionCacheStore, SESSION_CACHE_KEY } from './sessionCache'

function analysis(id = 'channel', title = id): ChannelCardOut {
  return { channel: { id, title }, sample: { selected_count: 0, metric_count: 0, uploads_scanned: 0,
    pages_scanned: 0, stop_reason: 'uploads_exhausted', target_reached: false, scan_limit_reached: false },
    metrics: { count: 0 }, summary: '', videos: [], fetched_at: '2026-01-01' }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup() {
  const getChannel = vi.fn<ApiClient['getChannel']>()
  const api: ApiClient = { getChannel, searchVideos: vi.fn(), getVideo: vi.fn() }
  const useCache = createSessionCacheStore()
  const cache = useCache()
  const store = createChannelsStore(() => api, useCache)()
  return { getChannel, cache, store }
}
beforeEach(() => setActivePinia(createPinia()))
describe('explicit channel cache store', () => {
  it('does no automatic work, caches shared analyses and explicitly refreshes', async () => {
    const { store, cache, getChannel } = setup()
    expect(getChannel).not.toHaveBeenCalled()
    getChannel.mockResolvedValue({ ...analysis(), source_video: { id: 'context', status: 'included' } })
    expect(await store.load('channel')).toBe(true)
    expect(store.response?.source_video?.id).toBe('context')
    expect(cache.getChannel(channelCacheKey('channel'))?.source_video).toBeUndefined()
    expect(await store.load('channel')).toBe(true)
    expect(getChannel).toHaveBeenCalledTimes(1)
    getChannel.mockResolvedValue(analysis('channel', 'updated'))
    expect(await store.load('channel', { forceSync: true })).toBe(true)
    expect(getChannel).toHaveBeenLastCalledWith('channel', { forceSync: true, signal: expect.any(AbortSignal) })
    expect(cache.getChannel(channelCacheKey('channel'))?.channel.title).toBe('updated')
  })
  it('passes source context only on network calls and never partitions the shared cache by video', async () => {
    const { store, getChannel, cache } = setup()
    getChannel.mockResolvedValue({ ...analysis(), source_video: { id: 'first', status: 'not_in_sample' } })
    await store.load('channel', { sourceVideoId: 'first' })
    expect(getChannel).toHaveBeenCalledWith('channel', { sourceVideoId: 'first', signal: expect.any(AbortSignal) })
    expect(store.response?.source_video?.id).toBe('first')
    expect(cache.getChannel(channelCacheKey('channel'))?.source_video).toBeUndefined()
    getChannel.mockRejectedValueOnce(new Error('offline'))
    await store.load('channel', { forceSync: true, sourceVideoId: 'first' })
    expect(store.response?.source_video?.id).toBe('first')
    await store.load('channel', { sourceVideoId: 'second' })
    expect(getChannel).toHaveBeenCalledTimes(2)
    expect(store.response?.source_video).toBeUndefined()
  })
  it('preserves the successful analysis on explicit refresh failure', async () => {
    const { store, cache, getChannel } = setup()
    getChannel.mockResolvedValueOnce(analysis())
    await store.load('channel')
    getChannel.mockRejectedValueOnce(new ApiError('Quota', { code: 'quota_exceeded' }))
    expect(await store.load('channel', { forceSync: true })).toBe(false)
    expect(store.response?.channel.id).toBe('channel')
    expect(cache.getChannel(channelCacheKey('channel'))).not.toBeNull()
    expect(store.error?.code).toBe('quota_exceeded')
  })
  it('coalesces duplicate same-key requests including force requests', async () => {
    const { store, getChannel } = setup()
    const request = deferred<ChannelCardOut>()
    getChannel.mockReturnValue(request.promise)
    const one = store.load('channel')
    const two = store.load('channel', { forceSync: true })
    expect(getChannel).toHaveBeenCalledTimes(1)
    request.resolve(analysis())
    expect(await Promise.all([one, two])).toEqual([true, true])
    expect(store.pending).toBe(false)
  })
  it('aborts obsolete work and ignores late success without caching it', async () => {
    const { store, cache, getChannel } = setup()
    const old = deferred<ChannelCardOut>()
    const current = deferred<ChannelCardOut>()
    getChannel.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const first = store.load('old')
    const signal = getChannel.mock.calls[0]![1]!.signal!
    const second = store.load('new')
    expect(signal.aborted).toBe(true)
    old.resolve(analysis('old'))
    expect(await first).toBe(false)
    expect(store.pending).toBe(true)
    expect(cache.getChannel(channelCacheKey('old'))).toBeNull()
    current.resolve(analysis('new'))
    expect(await second).toBe(true)
    expect(store.response?.channel.id).toBe('new')
  })
  it('ignores obsolete failures and externally aborted responses', async () => {
    const { store, getChannel } = setup()
    const old = deferred<ChannelCardOut>()
    getChannel.mockReturnValueOnce(old.promise).mockResolvedValueOnce(analysis('new'))
    const first = store.load('old')
    await store.load('new')
    old.reject(new Error('Old failure'))
    expect(await first).toBe(false)
    expect(store.error).toBeNull()
    const external = new AbortController()
    const late = deferred<ChannelCardOut>()
    getChannel.mockReturnValueOnce(late.promise)
    const cancelled = store.load('new', { forceSync: true, signal: external.signal })
    external.abort()
    late.resolve(analysis('new', 'unwanted'))
    expect(await cancelled).toBe(false)
    expect(store.response?.channel.title).toBe('new')
  })
  it('rejects malformed success and keeps previous good data', async () => {
    const { store, getChannel } = setup()
    getChannel.mockResolvedValueOnce(analysis())
    await store.load('channel')
    getChannel.mockResolvedValueOnce({ ...analysis(), videos: [{ id: 'v', title: 'bad', view_count: 'bad' }] } as unknown as ChannelCardOut)
    expect(await store.load('channel', { forceSync: true })).toBe(false)
    expect(store.error?.code).toBe('invalid_response')
    expect(store.response?.channel.id).toBe('channel')
  })
  it('does not persist a dangling active key after an uncached failure', async () => {
    const data = new Map<string, string>()
    const storage: Storage = { get length() { return data.size }, clear: () => data.clear(), key: i => [...data.keys()][i] ?? null,
      getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
    const useCache = createSessionCacheStore(() => storage)
    const cache = useCache()
    cache.putChannel(channelCacheKey('good'), analysis('good'))
    const api: ApiClient = { getChannel: vi.fn().mockRejectedValue(new Error('Failed')), searchVideos: vi.fn(), getVideo: vi.fn() }
    const store = createChannelsStore(() => api, useCache)()
    expect(await store.load('missing')).toBe(false)
    cache.save()
    expect(JSON.parse(storage.getItem(SESSION_CACHE_KEY)!).activeChannelKey).toBe(channelCacheKey('good'))
    setActivePinia(createPinia())
    const restored = createSessionCacheStore(() => storage)()
    expect(restored.getChannel(channelCacheKey('good'))).not.toBeNull()
    expect(restored.persistenceWarning).toBeNull()
  })
  it('enforces the shared ten-analysis limit', async () => {
    const { store, cache, getChannel } = setup()
    getChannel.mockImplementation(async id => analysis(id))
    for (let i = 0; i < 11; i++) await store.load(String(i))
    expect(cache.getChannel(channelCacheKey('0'))).toBeNull()
    expect(cache.getChannel(channelCacheKey('10'))).not.toBeNull()
  })
})

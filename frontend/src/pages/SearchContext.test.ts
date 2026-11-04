// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import { createAppRouter } from '../router'
import { createSearchStore } from '../stores/search'
import { channelCacheKey, createSessionCacheStore } from '../stores/sessionCache'
import type { ApiClient } from '../api'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks() })

async function setup() {
  const pinia = createPinia()
  const data = new Map<string, string>()
  const disk: Storage = { get length() { return data.size }, clear: () => data.clear(), key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
  const cache = createSessionCacheStore(() => disk)(pinia)
  cache.putChannel(channelCacheKey('UC_example'), {
    channel: { id: 'UC_example', title: 'Пример канала' },
    sample: { selected_count: 0, metric_count: 0, uploads_scanned: 0, pages_scanned: 0,
      stop_reason: 'uploads_exhausted', target_reached: false, scan_limit_reached: false },
    metrics: { count: 0 }, summary: '', videos: [], fetched_at: '2026-02-01T00:00:00Z',
  })
  const searchVideos = vi.fn<ApiClient['searchVideos']>().mockResolvedValue({
    query: 'Topic', applied: { query: 'Topic' }, videos: [{ id: 'origin', title: 'Example', channel_id: 'UC_example' }],
    fetched_at: '2026-02-01T00:00:00Z', items_scanned: 1, matched_count: 1, quota_used_estimate: 102, next_page_token: null,
  })
  const store = createSearchStore(() => ({ searchVideos, getChannel: vi.fn(), getVideo: vi.fn() }), () => cache)(pinia)
  store.patchDraft({ query: 'Topic' })
  await store.search()
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  await router.isReady()
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return { store, router, searchVideos, scrollTo, cache, pinia, disk }
}

describe('search navigation context', () => {
  it('restores scroll and originating action after two channel visits, without searching again', async () => {
    const { store, router, searchVideos, scrollTo } = await setup()
    store.patchDraft({ query: 'Unapplied' })
    store.setSort('views')
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(612)
    for (let visit = 0; visit < 2; visit++) {
      await wrapper!.get('#analysis-origin').trigger('click')
      await flushPromises()
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('channel'))
      expect(wrapper!.get('a.text-action').text()).toBe('К результатам поиска')
      expect(document.activeElement?.id).toBe('page-title')
      await wrapper!.get('a.text-action').trigger('click')
      await flushPromises()
      await vi.waitFor(() => expect(document.activeElement?.id).toBe('analysis-origin'))
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 612, behavior: 'instant' })
    }
    expect(store.draft.query).toBe('Unapplied')
    expect(store.sortMode).toBe('views')
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })

  it('restores browser Back and Forward without a request or competing top reset', async () => {
    const { router, scrollTo, searchVideos } = await setup()
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(450)
    await wrapper!.get('#analysis-origin').trigger('click')
    await flushPromises()
    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('search'))
    await flushPromises()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 450, behavior: 'instant' })
    router.forward()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('channel'))
    await flushPromises()
    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('search'))
    await flushPromises()
    expect(document.activeElement?.id).toBe('analysis-origin')
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })

  it('restores persisted position and focus on a freshly mounted search page', async () => {
    const { store, scrollTo, disk } = await setup()
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(777)
    store.saveContext(777, 'origin')
    wrapper!.unmount()
    const pinia = createPinia()
    const cache = createSessionCacheStore(() => disk)(pinia)
    const searchVideos = vi.fn<ApiClient['searchVideos']>()
    createSearchStore(() => ({ searchVideos, getChannel: vi.fn(), getVideo: vi.fn() }), () => cache)(pinia)
    const restoredRouter = createAppRouter(createMemoryHistory())
    await restoredRouter.push('/')
    await restoredRouter.isReady()
    wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, restoredRouter] } })
    await flushPromises()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 777, behavior: 'instant' })
    expect(document.activeElement?.id).toBe('analysis-origin')
    expect(searchVideos).not.toHaveBeenCalled()
  })

  it('repeating an identical search uses the cache and restores its saved position', async () => {
    const { store, searchVideos, scrollTo } = await setup()
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(370)
    await wrapper!.get('input#search-query').setValue('Topic')
    const searchButton = wrapper!.findAll('button').find(button => button.text() === 'Искать')!
    await searchButton.trigger('click')
    await flushPromises()
    expect(searchVideos).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 370, behavior: 'instant' })
    expect(store.scrollY).toBe(370)
  })

  it('persists current scroll on pagehide and shows nonblocking storage warning', async () => {
    const { store, cache } = await setup()
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(999)
    window.dispatchEvent(new Event('pagehide'))
    expect(store.scrollY).toBe(999)
    cache.persistenceWarning = 'Перезагрузка может потерять состояние.'
    await flushPromises()
    expect(wrapper!.text()).toContain('Перезагрузка может потерять состояние.')
    expect(wrapper!.findAll('.video-card')).toHaveLength(1)
  })
})

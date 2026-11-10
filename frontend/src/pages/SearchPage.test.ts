// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { NSelect } from 'naive-ui'
import App from '../App.vue'
import { ApiError } from '../api'
import type { ApiClient, SearchVideosRequest, SearchVideosResponse, VideoOut } from '../api'
import SearchForm from '../features/search/SearchForm.vue'
import VideoCard from '../features/search/VideoCard.vue'
import { createEmptyDraft } from '../features/search/model'
import { createAppRouter } from '../router'
import { createSearchStore, useSearchStore } from '../stores/search'
import SearchPage from './SearchPage.vue'
import { channelCacheKey, createSessionCacheStore } from '../stores/sessionCache'

const fetchedAt = '2026-02-01T12:00:00Z'
const video: VideoOut = {
  id: 'video_stage6', title: 'Исходное видео', channel_id: 'UC_stage6', channel_title: 'Исходный канал',
  view_count: 0, channel_subscriber_count: 0, channel_subscriber_count_hidden: null, view_sub_ratio: null,
  duration_seconds: 181, published_at: '2026-02-01T09:00:00Z', thumbnail_url: null,
}
const mounted: VueWrapper[] = []
const cleanup: Array<() => void> = []
const resourceCalls: Array<Pick<ApiClient, 'getChannel' | 'getVideo'>> = []
const fetchMock = vi.fn<typeof globalThis.fetch>()

function responseFor(request: SearchVideosRequest, overrides: Partial<SearchVideosResponse> = {}): SearchVideosResponse {
  const applied = { ...request }
  if (request.duration_ranges !== undefined) applied.duration_ranges = [...request.duration_ranges]
  const videos = overrides.videos ?? [{ ...video }]
  return {
    query: request.query ?? '', applied, videos, fetched_at: fetchedAt, next_page_token: null,
    items_scanned: 50, matched_count: videos.length, quota_used_estimate: 0, order: 'relevance',
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

beforeEach(() => {
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected transport call in a fake-client test'))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

afterEach(() => {
  for (const cancel of cleanup.splice(0)) cancel()
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.replaceChildren()
  try {
    expect(fetchMock).not.toHaveBeenCalled()
    for (const api of resourceCalls.splice(0)) {
      expect(api.getChannel).not.toHaveBeenCalled()
      expect(api.getVideo).not.toHaveBeenCalled()
    }
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

async function openSearch() {
  const searchVideos = vi.fn<ApiClient['searchVideos']>().mockImplementation(async request => responseFor(request))
  const getChannel = vi.fn<ApiClient['getChannel']>()
  const getVideo = vi.fn<ApiClient['getVideo']>()
  const api: ApiClient = { searchVideos, getChannel, getVideo }
  const factory = vi.fn(() => api)
  const pinia = createPinia()
  const cache = createSessionCacheStore()(pinia)
  cache.putChannel(channelCacheKey('UC_stage6'), {
    channel: { id: 'UC_stage6', title: 'Анализ канала' },
    sample: { selected_count: 0, metric_count: 0, uploads_scanned: 0, pages_scanned: 0,
      stop_reason: 'uploads_exhausted', target_reached: false, scan_limit_reached: false },
    metrics: { count: 0 }, summary: '', videos: [], fetched_at: fetchedAt,
  })
  const store = createSearchStore(factory, () => cache)(pinia)
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  await router.isReady()
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router] } })
  mounted.push(wrapper)
  cleanup.push(() => store.cancel())
  resourceCalls.push(api)
  await flushPromises()
  await nextTick()
  expect(useSearchStore(pinia)).toBe(store)
  expect(wrapper.findComponent(SearchPage).exists()).toBe(true)
  expect(wrapper.getComponent(SearchForm).props('draft')).toBe(store.draft)
  expect(factory).not.toHaveBeenCalled()
  return { wrapper, router, store, factory, searchVideos, getChannel, getVideo }
}

// Real NSelect instance and public update event; popup layout/selection is not emulated in jsdom.
async function setLanguage(wrapper: VueWrapper, value: string | null) {
  wrapper.getComponent(NSelect).vm.$emit('update:value', value)
  await nextTick()
}

async function keydown(wrapper: VueWrapper, selector: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
  wrapper.get(selector).element.dispatchEvent(event)
  await nextTick()
  return event
}

function retryButton(wrapper: VueWrapper) {
  const button = wrapper.findAll('button').find(candidate => candidate.text() === 'Повторить запрос')
  if (!button) throw new Error('Expected an explicit retry button')
  return button
}

describe('real search form interactions', () => {
  it('does not request on mount, query/filter edits, reset, or opening/closing in-flow filters', async () => {
    const { wrapper, store, factory, searchVideos } = await openSearch()
    expect(wrapper.get('h1').text()).toBe('Поиск видео')
    expect(wrapper.text()).toContain('Задайте условия и начните поиск')
    expect(wrapper.get('form').attributes('novalidate')).toBeDefined()
    expect(wrapper.get('.main-search').attributes('type')).toBe('button')
    expect(wrapper.get('.mobile-search').attributes('type')).toBe('button')
    await wrapper.get('#search-query').setValue('  тема без отправки  ')
    await setLanguage(wrapper, 'zh-Hant')
    await wrapper.get('#search-subs-min').setValue('0')
    await wrapper.get('#search-subs-max').setValue('1000')
    await wrapper.get('#search-period').setValue('month')
    const details = wrapper.get<HTMLDetailsElement>('.duration-disclosure')
    await details.get('summary').trigger('click')
    expect(details.element.open).toBe(true)
    await wrapper.get('input[type="checkbox"][value="over_60m"]').setValue(true)
    await wrapper.get('input[type="checkbox"][value="3_to_10m"]').setValue(true)
    await details.get('summary').trigger('click')
    expect(details.element.open).toBe(false)
    expect(store.draft.durationRanges).toEqual(['3_to_10m', 'over_60m'])
    expect(wrapper.get('.duration-disclosure summary').attributes('aria-labelledby')).toBeUndefined()
    expect(wrapper.get('.duration-disclosure summary').text()).toContain('Длительность видео: Выбрано: 2')
    expect(wrapper.findAll('[role="combobox"]')).toHaveLength(1)
    expect(wrapper.get('.filters-trigger').text()).toContain('выбрано 4')
    await wrapper.get('.filters-trigger').trigger('click')
    expect(wrapper.get('.filters-trigger').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('#search-filters').classes()).toContain('is-open')
    await wrapper.get('.filters-trigger').trigger('click')
    expect(wrapper.get('.filters-trigger').attributes('aria-expanded')).toBe('false')
    expect(store.draft.language).toBe('zh-Hant')
    await setLanguage(wrapper, null)
    expect(store.draft.language).toBe('')
    const reset = wrapper.findAll('button').find(button => button.text() === 'Сбросить фильтры')
    if (!reset) throw new Error('Expected reset filters button')
    await reset.trigger('click')
    expect(store.draft).toEqual({ ...createEmptyDraft(), query: '  тема без отправки  ' })
    expect(wrapper.getComponent(NSelect).props('value')).toBe('')
    expect(wrapper.get<HTMLInputElement>('#search-subs-min').element.value).toBe('')
    expect(wrapper.get<HTMLSelectElement>('#search-period').element.value).toBe('all')
    expect(wrapper.get('.filters-trigger').text()).toContain('выбрано 0')
    expect(store.response).toBeNull()
    expect(factory).not.toHaveBeenCalled()
    expect(searchVideos).not.toHaveBeenCalled()
  })

  it('sends an optional topic with selected language, zero bound, period, and canonical duration union only on Search', async () => {
    const { wrapper, factory, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('  ')
    await setLanguage(wrapper, 'zh-Hans')
    await wrapper.get('#search-subs-min').setValue('0')
    await wrapper.get('#search-subs-max').setValue('1000')
    await wrapper.get('#search-period').setValue('month')
    await wrapper.get('.duration-disclosure summary').trigger('click')
    await wrapper.get('input[type="checkbox"][value="over_60m"]').setValue(true)
    await wrapper.get('input[type="checkbox"][value="3_to_10m"]').setValue(true)
    expect(searchVideos).not.toHaveBeenCalled()
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(searchVideos).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(searchVideos.mock.calls[0]?.[0]).toEqual({
      query: '', limit: 50, period: 'month', relevance_language: 'zh-Hans', min_subscribers: 0, max_subscribers: 1000,
      duration_ranges: ['3_to_10m', 'over_60m'],
    })
    expect(searchVideos.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(wrapper.get('.applied-text').text()).toContain('Без темы')
    expect(wrapper.findAllComponents(VideoCard)).toHaveLength(1)
  })

  it.each(['.main-search', '.mobile-search'])('runs a first-page search via the explicit %s button', async selector => {
    const { wrapper, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('  中文 тема 🚙  ')
    await wrapper.get(selector).trigger('click')
    await flushPromises()
    expect(searchVideos).toHaveBeenCalledTimes(1)
    expect(searchVideos.mock.calls[0]?.[0]).toEqual({ query: '中文 тема 🚙', limit: 50, period: 'all', duration_ranges: [] })
    expect(wrapper.get<HTMLInputElement>('#search-query').element.value).toBe('  中文 тема 🚙  ')
  })

  it('runs a search on Enter in the actual query input and prevents native submission', async () => {
    const { wrapper, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('  ремонт  ')
    expect(searchVideos).not.toHaveBeenCalled()
    const event = await keydown(wrapper, '#search-query')
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(searchVideos).toHaveBeenCalledTimes(1)
    expect(searchVideos.mock.calls[0]?.[0].query).toBe('ремонт')
  })

  it('does not search for other keys, Enter in other fields, or implicit/native form submit', async () => {
    const { wrapper, factory, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('тема')
    await keydown(wrapper, '#search-query', { key: 'a' })
    for (const selector of ['#search-subs-min', '#search-subs-max', '#search-period', 'input[type="checkbox"]']) {
      await keydown(wrapper, selector)
    }
    await wrapper.getComponent(NSelect).trigger('keydown', { key: 'Enter' })
    const submit = new Event('submit', { bubbles: true, cancelable: true })
    wrapper.get('form').element.dispatchEvent(submit)
    expect(submit.defaultPrevented).toBe(true)
    await flushPromises()
    expect(factory).not.toHaveBeenCalled()
    expect(searchVideos).not.toHaveBeenCalled()
  })

  it('suppresses Enter during composition until a real compositionend event', async () => {
    const { wrapper, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('中文')
    await wrapper.get('#search-query').trigger('compositionstart')
    const composing = await keydown(wrapper, '#search-query')
    expect(composing.defaultPrevented).toBe(true)
    expect(searchVideos).not.toHaveBeenCalled()
    await wrapper.get('#search-query').trigger('compositionend')
    await keydown(wrapper, '#search-query')
    await flushPromises()
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'native isComposing', options: { isComposing: true } },
    { label: 'legacy keyCode 229', options: { keyCode: 229 } },
  ])('suppresses Enter carrying $label even without a prior compositionstart', async ({ options }) => {
    const { wrapper, searchVideos } = await openSearch()
    const event = await keydown(wrapper, '#search-query', options)
    expect(event.defaultPrevented).toBe(true)
    if ('isComposing' in options) expect(event.isComposing).toBe(true)
    else expect(event.keyCode).toBe(229)
    await flushPromises()
    expect(searchVideos).not.toHaveBeenCalled()
    await keydown(wrapper, '#search-query')
    await flushPromises()
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })

  it.each(['-1', '+1', '1.5', '1e3', '1 ', '9007199254740992'])('rejects raw numeric input %j without clamping and focuses the first field error', async raw => {
    const { wrapper, store, factory, searchVideos } = await openSearch()
    await wrapper.get('#search-subs-min').setValue(raw)
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.get<HTMLInputElement>('#search-subs-min').element.value).toBe(raw)
    expect(store.draft.minSubscribers).toBe(raw)
    expect(wrapper.get('#subs-min-error').text()).toBe(store.fieldErrors.minSubscribers)
    expect(wrapper.get('#search-subs-min').attributes('aria-invalid')).toBe('true')
    expect(document.activeElement?.id).toBe('search-subs-min')
    expect(wrapper.get('#search-filters').classes()).toContain('is-open')
    expect(factory).not.toHaveBeenCalled()
    expect(searchVideos).not.toHaveBeenCalled()
    expect(store.canRetry).toBe(false)
  })

  it('focuses the actual language input and associates its validation error without requesting', async () => {
    const { wrapper, store, factory, searchVideos } = await openSearch()
    await setLanguage(wrapper, 'zh')
    wrapper.get<HTMLButtonElement>('.main-search').element.focus()
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    await nextTick()
    const language = wrapper.get<HTMLInputElement>('#search-language')
    expect(document.activeElement).toBe(language.element)
    expect(document.activeElement?.id).toBe('search-language')
    expect(language.attributes('aria-invalid')).toBe('true')
    expect(language.attributes('aria-describedby')?.split(/\s+/)).toEqual(['language-hint', 'language-error'])
    expect(wrapper.get('#language-error').attributes('role')).toBe('alert')
    expect(wrapper.get('#language-error').text()).toBe(store.fieldErrors.language)
    expect(wrapper.get('#language-error').text()).toContain('Выберите язык из списка')
    expect(wrapper.get('#search-filters').classes()).toContain('is-open')
    expect(factory).not.toHaveBeenCalled()
    expect(searchVideos).not.toHaveBeenCalled()
  })

  it('focuses an overlong query before numeric errors, then focuses the remaining filter error', async () => {
    const { wrapper, store, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('中'.repeat(501))
    await wrapper.get('#search-subs-max').setValue('1e3')
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(wrapper.get('#query-error').text()).toBe(store.fieldErrors.query)
    expect(document.activeElement?.id).toBe('search-query')
    expect(wrapper.get('#search-query').attributes('aria-describedby')).toContain('query-error')
    await wrapper.get('#search-query').setValue('中'.repeat(500))
    expect(wrapper.find('#query-error').exists()).toBe(false)
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(document.activeElement?.id).toBe('search-subs-max')
    expect(wrapper.get('#search-filters').classes()).toContain('is-open')
    expect(searchVideos).not.toHaveBeenCalled()
  })

  it('rejects reversed subscriber bounds and focuses the maximum rather than sending them', async () => {
    const { wrapper, searchVideos } = await openSearch()
    await wrapper.get('#search-subs-min').setValue('11')
    await wrapper.get('#search-subs-max').setValue('10')
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(wrapper.get('#subs-max-error').text()).toContain('меньше минимума')
    expect(document.activeElement?.id).toBe('search-subs-max')
    expect(searchVideos).not.toHaveBeenCalled()
  })
})

describe('request state rendered by the real page and cards', () => {
  it('blocks duplicate Search/Enter while busy and keeps the pending snapshot through edits and reset', async () => {
    const { wrapper, store, factory, searchVideos } = await openSearch()
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    await wrapper.get('#search-query').setValue('первая')
    await setLanguage(wrapper, 'ru')
    await wrapper.get('#search-subs-min').setValue('0')
    await wrapper.get('input[type="checkbox"][value="3_to_10m"]').setValue(true)
    await wrapper.get('.main-search').trigger('click')
    const request: SearchVideosRequest = {
      query: 'первая', limit: 50, period: 'all', relevance_language: 'ru', min_subscribers: 0, duration_ranges: ['3_to_10m'],
    }
    const pending = store.pending
    const signal = searchVideos.mock.calls[0]?.[1]?.signal
    expect(wrapper.get<HTMLButtonElement>('.main-search').element.disabled).toBe(true)
    expect(wrapper.get<HTMLButtonElement>('.mobile-search').element.disabled).toBe(true)
    expect(wrapper.get('.first-load-skeleton').attributes('aria-hidden')).toBe('true')
    await wrapper.get('.main-search').trigger('click')
    await wrapper.get('.mobile-search').trigger('click')
    await keydown(wrapper, '#search-query')
    await wrapper.get('#search-query').setValue('позже')
    await wrapper.get('input[type="checkbox"][value="over_60m"]').setValue(true)
    expect(wrapper.text()).toContain('Изменения в форме не входят в выполняющийся запрос.')
    const reset = wrapper.findAll('button').find(button => button.text() === 'Сбросить фильтры')
    if (!reset) throw new Error('Expected reset filters button')
    await reset.trigger('click')
    expect(store.pending).toBe(pending)
    expect(store.pending?.request).toEqual(request)
    expect(store.draft).toEqual({ ...createEmptyDraft(), query: 'позже' })
    expect(signal?.aborted).toBe(false)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(searchVideos).toHaveBeenCalledTimes(1)
    task.resolve(responseFor(request))
    await flushPromises()
    expect(store.busy).toBe(false)
    expect(wrapper.get('.applied-text').text()).toContain('«первая»')
    expect(wrapper.get('.draft-notice').text()).toContain('Параметры изменены')
    expect(wrapper.get<HTMLInputElement>('#search-query').element.value).toBe('позже')
  })

  it('keeps old applied labels and video data while a changed draft loads and then fails', async () => {
    const { wrapper, store, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('первая')
    await setLanguage(wrapper, 'ru')
    await wrapper.get('#search-period').setValue('month')
    searchVideos.mockImplementationOnce(async request => responseFor(request, {
      applied: { ...request, published_after: '2026-01-01T12:00:00Z' },
      videos: [{ ...video, title: 'Прежняя карточка' }],
    }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    const previous = store.response
    const labels = wrapper.get('.applied-text').text()
    expect(labels).toContain('«первая»')
    expect(labels).toContain('01.01.2026')
    expect(labels).toContain('UTC')
    expect(wrapper.find('.draft-notice').exists()).toBe(false)
    await wrapper.get('#search-query').setValue('вторая')
    await setLanguage(wrapper, 'zh-Hant')
    await wrapper.get('#search-period').setValue('year')
    expect(wrapper.get('.draft-notice').text()).toContain('Нажмите «Искать»')
    expect(wrapper.get('.applied-text').text()).toBe(labels)
    expect(wrapper.get('.video-title').text()).toBe('Прежняя карточка')
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    await wrapper.get('.main-search').trigger('click')
    expect(wrapper.get('.results').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.request-status').text()).toContain('Ниже — предыдущая выдача')
    expect(wrapper.get('.applied-text').text()).toBe(labels)
    expect(wrapper.get('.video-title').text()).toBe('Прежняя карточка')
    expect(wrapper.find('.draft-notice').exists()).toBe(false)
    task.reject(new ApiError('Не удалось связаться с сервисом.', { code: 'network_error', retryable: true }))
    await flushPromises()
    expect(store.response).toBe(previous)
    expect(wrapper.get('.results').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.applied-text').text()).toBe(labels)
    expect(wrapper.get('.video-title').text()).toBe('Прежняя карточка')
    expect(wrapper.get('.request-error').attributes('role')).toBe('alert')
    expect(wrapper.get('.request-error').text()).toContain('Ранее полученные видео и условия текущей выдачи сохранены.')
    expect(wrapper.get('.draft-notice').text()).toContain('Параметры изменены')
    expect(searchVideos).toHaveBeenCalledTimes(2)
  })

  it('shows a controlled invalid_response for malformed video entries and preserves prior cards and labels', async () => {
    const { wrapper, store, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('прежняя')
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    const previous = store.response
    const labels = wrapper.get('.applied-text').text()
    searchVideos.mockResolvedValueOnce({
      ...responseFor({ query: 'некорректная' }), videos: [null],
    } as unknown as SearchVideosResponse)
    await wrapper.get('#search-query').setValue('некорректная')
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(store.error?.code).toBe('invalid_response')
    expect(wrapper.get('.request-error').attributes('role')).toBe('alert')
    expect(wrapper.get('.request-error').text()).toContain('Сервис вернул некорректный ответ.')
    expect(store.response).toBe(previous)
    expect(wrapper.get('.applied-text').text()).toBe(labels)
    expect(wrapper.get('.video-title').text()).toBe(video.title)
    expect(wrapper.findAllComponents(VideoCard)).toHaveLength(1)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
    expect(searchVideos).toHaveBeenCalledTimes(2)
  })

  it('refreshes applied filters and the server UTC boundary without applying an unsent or invalid draft', async () => {
    const { wrapper, store, searchVideos } = await openSearch()
    const applied: SearchVideosRequest = {
      query: 'применённая', limit: 50, period: 'month', relevance_language: 'ru',
      duration_ranges: ['3_to_10m', 'over_60m'], min_subscribers: 0, max_subscribers: 1000,
      min_views: 0, max_views: null, published_after: '2026-01-01T12:00:00Z',
      published_before: '2027-01-01T00:00:00Z', page_token: null,
    }
    store.patchDraft({ query: 'применённая', period: 'month', language: 'ru', minSubscribers: '0', maxSubscribers: '1000', durationRanges: ['3_to_10m', 'over_60m'] })
    searchVideos.mockImplementationOnce(async request => responseFor(request, { applied: { ...request, published_after: '2026-01-01T12:00:00Z' } }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    // Simulate an API-capable restored session with noneditable bounds.
    store.response = responseFor(applied)
    await nextTick()
    const labels = wrapper.get('.applied-text').text()
    await wrapper.get('#search-query').setValue('неприменённая')
    await setLanguage(wrapper, 'zh-Hans')
    await wrapper.get('#search-subs-min').setValue('-1')
    await wrapper.get('#search-period').setValue('year')
    const draft = { ...store.draft, durationRanges: [...store.draft.durationRanges] }
    const request: SearchVideosRequest = {
      query: 'применённая', limit: 50, period: 'month', relevance_language: 'ru',
      duration_ranges: ['3_to_10m', 'over_60m'], min_subscribers: 0, max_subscribers: 1000,
      min_views: 0, max_views: null, published_before: '2027-01-01T00:00:00Z',
    }
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    const refresh = wrapper.findAll('button').find(button => button.text() === 'Обновить выдачу')
    if (!refresh) throw new Error('Expected refresh button')
    await refresh.trigger('click')
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(store.pending).toEqual({ kind: 'refresh', request })
    expect(wrapper.get('.request-status').text()).toContain('Обновляем текущую выдачу')
    expect(wrapper.get('.applied-text').text()).toBe(labels)
    expect(refresh.element.disabled).toBe(true)
    await refresh.trigger('click')
    await wrapper.get('.main-search').trigger('click')
    expect(searchVideos).toHaveBeenCalledTimes(2)
    expect(store.draft).toEqual(draft)
    task.resolve(responseFor(request, {
      applied: { ...request, published_after: '2026-01-02T12:00:00Z' }, fetched_at: '2026-02-02T12:00:00Z',
    }))
    await flushPromises()
    expect(store.draft).toEqual(draft)
    expect(wrapper.get<HTMLInputElement>('#search-query').element.value).toBe('неприменённая')
    expect(wrapper.get<HTMLInputElement>('#search-subs-min').element.value).toBe('-1')
    expect(wrapper.get('.applied-text').text()).toContain('«применённая»')
    expect(wrapper.get('.applied-text').text()).not.toContain('«неприменённая»')
    expect(wrapper.get('.applied-text').text()).toContain('02.01.2026')
    expect(wrapper.find('.draft-notice').exists()).toBe(true)
    expect(wrapper.find('#subs-min-error').exists()).toBe(false)
  })

  it.each([
    { code: 'quota_exceeded', status: 429, title: 'Квота YouTube исчерпана' },
    { code: 'source_not_configured', status: 503, title: 'Не удалось получить видео' },
  ])('renders manual retry for $code with false retryable metadata and retries the captured search', async ({ code, status, title }) => {
    const { wrapper, store, factory, searchVideos } = await openSearch()
    await wrapper.get('#search-query').setValue('неудавшаяся')
    await wrapper.get('#search-subs-min').setValue('0')
    await wrapper.get('#search-period').setValue('week')
    await wrapper.get('input[type="checkbox"][value="3_to_10m"]').setValue(true)
    const request: SearchVideosRequest = {
      query: 'неудавшаяся', limit: 50, period: 'week', duration_ranges: ['3_to_10m'], min_subscribers: 0,
    }
    searchVideos.mockRejectedValueOnce(new ApiError('Сервис пока недоступен.', { code, status, retryable: false }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(wrapper.get('#search-error-title').text()).toBe(title)
    expect(store.error?.retryable).toBe(false)
    expect(store.canRetry).toBe(true)
    expect(retryButton(wrapper).element.disabled).toBe(false)
    expect(searchVideos).toHaveBeenCalledTimes(1)
    await wrapper.get('#search-query').setValue('новый черновик')
    await wrapper.get('#search-subs-min').setValue('100')
    await wrapper.get('#search-period').setValue('year')
    const draft = { ...store.draft, durationRanges: [...store.draft.durationRanges] }
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    await retryButton(wrapper).trigger('click')
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(store.pending).toEqual({ kind: 'search', request })
    expect(store.draft).toEqual(draft)
    expect(wrapper.find('.request-error').exists()).toBe(false)
    expect(wrapper.text()).toContain('Изменения в форме не входят в выполняющийся запрос.')
    task.resolve(responseFor(request, { applied: { ...request, published_after: '2026-01-25T12:00:00Z' } }))
    await flushPromises()
    expect(wrapper.get('.applied-text').text()).toContain('«неудавшаяся»')
    expect(wrapper.get('.applied-text').text()).not.toContain('«новый черновик»')
    expect(store.draft).toEqual(draft)
    expect(wrapper.find('.draft-notice').exists()).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(searchVideos).toHaveBeenCalledTimes(2)
  })

  it('focuses the first mapped backend 422 field after manual retry without changing the captured request or making extra calls', async () => {
    const { wrapper, store, factory, searchVideos } = await openSearch()
    const searchAction = vi.spyOn(store, 'search')
    const retryAction = vi.spyOn(store, 'retry')
    await wrapper.get('#search-query').setValue('первая')
    await setLanguage(wrapper, 'ru')
    await wrapper.get('#search-subs-min').setValue('0')
    await wrapper.get('#search-subs-max').setValue('10')
    await wrapper.get('#search-period').setValue('week')
    await wrapper.get('input[type="checkbox"][value="3_to_10m"]').setValue(true)
    const request: SearchVideosRequest = {
      query: 'первая', limit: 50, period: 'week', relevance_language: 'ru',
      duration_ranges: ['3_to_10m'], min_subscribers: 0, max_subscribers: 10,
    }
    searchVideos.mockRejectedValueOnce(new ApiError('Не удалось связаться с сервисом.', { code: 'network_error', retryable: true }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(searchVideos.mock.calls[0]?.[0]).toEqual(request)
    expect(store.fieldErrors).toEqual({})
    await wrapper.get('#search-query').setValue('неприменённая')
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    const retry = retryButton(wrapper)
    retry.element.focus()
    expect(document.activeElement).toBe(retry.element)
    await retry.trigger('click')
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(store.pending).toEqual({ kind: 'search', request })
    expect(store.draft.query).toBe('неприменённая')
    expect(searchAction).toHaveBeenCalledTimes(1)
    expect(retryAction).toHaveBeenCalledTimes(1)
    // Restore matching criteria so the mapped backend errors belong to the visible draft.
    await wrapper.get('#search-query').setValue('  первая  ')
    task.reject(new ApiError('Проверьте условия поиска.', {
      code: 'validation_error', status: 422, retryable: false, fields: [
        { loc: ['body', 'max_subscribers'], type: 'value_error', message: 'Проверьте максимум подписчиков.' },
        { loc: ['body', 'min_subscribers'], type: 'value_error', message: 'Проверьте минимум подписчиков.' },
      ],
    }))
    await flushPromises()
    await nextTick()
    expect(wrapper.get('#search-error-title').text()).toBe('Проверьте условия поиска')
    expect(store.fieldErrors).toEqual({
      maxSubscribers: 'Проверьте максимум подписчиков.', minSubscribers: 'Проверьте минимум подписчиков.',
    })
    expect(document.activeElement?.id).toBe('search-subs-min')
    expect(wrapper.get('#search-subs-min').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('#search-subs-min').attributes('aria-describedby')).toBe('subs-min-error')
    expect(wrapper.get('#subs-min-error').text()).toBe('Проверьте минимум подписчиков.')
    expect(wrapper.get('#search-filters').classes()).toContain('is-open')
    expect(store.draft.query).toBe('  первая  ')
    expect(searchVideos.mock.calls.map(([body]) => body)).toEqual([request, request])
    expect(searchVideos).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(searchAction).toHaveBeenCalledTimes(1)
    expect(retryAction).toHaveBeenCalledTimes(1)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
  })

  it('retries a failed refresh as refresh, preserving old results and recalculating the boundary rather than using draft', async () => {
    const { wrapper, store, searchVideos } = await openSearch()
    const applied: SearchVideosRequest = {
      query: 'применённая', limit: 50, period: 'day', duration_ranges: ['3_to_10m'],
      published_after: '2026-01-31T12:00:00Z', published_before: null, page_token: null,
    }
    store.patchDraft({ query: 'применённая', period: 'day', durationRanges: ['3_to_10m'] })
    const previous = responseFor(applied)
    searchVideos.mockResolvedValueOnce(previous)
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    await wrapper.get('#search-query').setValue('неприменённая')
    searchVideos.mockRejectedValueOnce(new ApiError('Квота исчерпана.', { code: 'quota_exceeded', status: 429, retryable: false }))
    const refresh = wrapper.findAll('button').find(button => button.text() === 'Обновить выдачу')
    if (!refresh) throw new Error('Expected refresh button')
    await refresh.trigger('click')
    await flushPromises()
    expect(store.response).toBe(previous)
    expect(wrapper.get('.video-title').text()).toBe(video.title)
    expect(wrapper.get('.applied-text').text()).toContain('31.01.2026')
    await wrapper.get('#search-query').setValue('ещё один черновик')
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    await retryButton(wrapper).trigger('click')
    const request: SearchVideosRequest = {
      query: 'применённая', limit: 50, period: 'day', duration_ranges: ['3_to_10m'], published_before: null,
    }
    expect(searchVideos.mock.calls[1]?.[0]).toEqual(request)
    expect(searchVideos.mock.calls[2]?.[0]).toEqual(request)
    expect(store.pending?.kind).toBe('refresh')
    expect(wrapper.get('.request-status').text()).toContain('Обновляем текущую выдачу')
    expect(wrapper.get('.applied-text').text()).toContain('31.01.2026')
    task.resolve(responseFor(request, { applied: { ...request, published_after: '2026-02-01T12:00:00Z' } }))
    await flushPromises()
    expect(store.draft.query).toBe('ещё один черновик')
    expect(wrapper.get('.applied-text').text()).toContain('«применённая»')
    expect(wrapper.get('.applied-text').text()).toContain('01.02.2026')
    expect(searchVideos).toHaveBeenCalledTimes(3)
  })

  it('explains an empty processed page and offers only explicit continuation without hidden next-page work', async () => {
    const { wrapper, searchVideos } = await openSearch()
    searchVideos.mockImplementationOnce(async request => responseFor(request, {
      videos: [], items_scanned: 50, matched_count: 0, next_page_token: 'opaque-next-page',
    }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    expect(wrapper.get('.results-count').text()).toBe('Загружено 0 видео')
    expect(wrapper.get('#empty-results-title').text()).toContain('В просмотренной части выдачи совпадений нет')
    expect(wrapper.text()).toContain('Из 50 проверенных кандидатов ни одно видео не подошло')
    expect(wrapper.text()).toContain('пустая обработанная страница не означает отсутствие совпадений на всём YouTube')
    expect(wrapper.text()).toContain('Обработано страниц: 1; кандидатов: 50; уникальных видео: 0')
    expect(wrapper.text()).toContain('не глобальные тренды')
    expect(wrapper.findAllComponents(VideoCard)).toHaveLength(0)
    expect(wrapper.get('.load-more').text()).toBe('Показать ещё')
    await wrapper.get('.ratio-explanation summary').trigger('click')
    await wrapper.get('.ratio-explanation summary').trigger('click')
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })

  it('renders source-order zero/unknown cards and in-flow disclosures without extra requests or prefetch', async () => {
    const { wrapper, searchVideos } = await openSearch()
    const videos: VideoOut[] = [
      { ...video, id: 'z_first', title: 'Первое, нули', view_count: 0, channel_subscriber_count: 0, duration_seconds: 0, view_sub_ratio: null },
      { ...video, id: 'a_second', title: 'Второе, неизвестное', view_count: null, channel_subscriber_count: null, channel_subscriber_count_hidden: null, duration_seconds: null },
      { ...video, id: 'm_third', title: 'Третье, нулевой коэффициент', view_count: 0, channel_subscriber_count: 50, view_sub_ratio: 0 },
    ]
    searchVideos.mockImplementationOnce(async request => responseFor(request, { videos }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    const cards = wrapper.findAllComponents(VideoCard)
    expect(cards.map(card => card.get('.video-title').text())).toEqual(videos.map(item => item.title))
    const first = cards[0]
    const second = cards[1]
    const third = cards[2]
    if (!first || !second || !third) throw new Error('Expected three real video cards')
    expect(first.get('.video-metadata').text()).toContain('Просмотры:0')
    expect(first.get('.video-duration').text()).toBe('0:00')
    expect(first.get('.ratio-number').text()).toBe('—')
    expect(second.text()).toContain('Нет данных')
    expect(second.text()).not.toContain('Подписчики скрыты')
    expect(second.get('.ratio-number').text()).toBe('—')
    expect(third.get('.ratio-number').text()).toBe('0×')
    const details = first.get<HTMLDetailsElement>('.video-details')
    await details.get('summary').trigger('click')
    expect(details.element.open).toBe(true)
    expect(details.get('.full-title').text()).toBe(videos[0]?.title)
    await details.get('summary').trigger('click')
    expect(details.element.open).toBe(false)
    const ratio = wrapper.get<HTMLDetailsElement>('.ratio-explanation')
    await ratio.get('summary').trigger('click')
    expect(ratio.element.open).toBe(true)
    await ratio.get('summary').trigger('click')
    expect(ratio.element.open).toBe(false)
    expect(first.get('.analysis-action').attributes('href')).toBe('/channels/UC_stage6?videoId=z_first')
    await first.get('.analysis-action').trigger('mouseenter')
    first.get<HTMLAnchorElement>('.analysis-action').element.focus()
    expect(first.get('a.video-title').attributes('rel')).toBe('noopener noreferrer')
    expect(first.get('a.video-title').attributes('target')).toBe('_blank')
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })
})

describe('explicit continuation and local sorting', () => {
  it('appends one applied page, removes duplicates, sorts locally and restores original order', async () => {
    const { wrapper, store, searchVideos } = await openSearch()
    const first = { ...video, id: 'a', title: 'Первое', view_count: 10 }
    const second = { ...video, id: 'b', title: 'Второе', view_count: 30 }
    searchVideos.mockImplementationOnce(async request => responseFor(request, { videos: [first, second], next_page_token: 'next' }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    await wrapper.get('#search-query').setValue('черновик')
    await wrapper.get('#search-sort').setValue('views')
    expect(wrapper.findAll('.video-title').map(item => item.text())).toEqual(['Второе', 'Первое'])
    expect(searchVideos).toHaveBeenCalledTimes(1)
    const task = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(task.promise)
    wrapper.get<HTMLButtonElement>('.load-more').element.focus()
    await wrapper.get('.load-more').trigger('click')
    expect(store.pending?.kind).toBe('more')
    expect(searchVideos.mock.calls[1]?.[0].query).toBe('')
    expect(searchVideos.mock.calls[1]?.[0].page_token).toBe('next')
    expect(wrapper.findAll('.video-title')).toHaveLength(2)
    expect(wrapper.get('.load-more').attributes('disabled')).toBeDefined()
    task.resolve(responseFor(searchVideos.mock.calls[1]![0], { videos: [{ ...first, title: 'Не заменять', view_count: 999 }, { ...video, id: 'c', title: 'Третье', view_count: 20 }], next_page_token: null }))
    await flushPromises()
    expect(wrapper.findAll('.video-title').map(item => item.text())).toEqual(['Второе', 'Третье', 'Первое'])
    expect(wrapper.get('.results-count').text()).toBe('Загружено 3 видео')
    expect(wrapper.find('.load-more').exists()).toBe(false)
    expect(document.activeElement?.getAttribute('role')).toBe('status')
    expect(document.activeElement?.textContent).toContain('Добавлено уникальных видео: 1')
    expect(wrapper.text()).toContain('Конец доступной выдачи')
    expect(wrapper.text()).toContain('Добавлено уникальных видео: 1')
    await wrapper.get('#search-sort').setValue('original')
    expect(wrapper.findAll('.video-title').map(item => item.text())).toEqual(['Первое', 'Второе', 'Третье'])
    expect(searchVideos).toHaveBeenCalledTimes(2)
    expect(store.draft.query).toBe('черновик')
  })

  it('keeps cards and continuation after a failed page and retries only on user action', async () => {
    const { wrapper, searchVideos } = await openSearch()
    searchVideos.mockImplementationOnce(async request => responseFor(request, { next_page_token: 'page2' }))
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    searchVideos.mockRejectedValueOnce(new ApiError('Источник недоступен.', { code: 'source_unavailable', status: 502 }))
    await wrapper.get('.load-more').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.video-title')).toHaveLength(1)
    expect(wrapper.find('.load-more').exists()).toBe(true)
    expect(searchVideos).toHaveBeenCalledTimes(2)
    searchVideos.mockImplementationOnce(async request => responseFor(request, { videos: [], matched_count: 0, next_page_token: 'page3' }))
    await retryButton(wrapper).trigger('click')
    await flushPromises()
    expect(searchVideos.mock.calls[2]?.[0]).toEqual(searchVideos.mock.calls[1]?.[0])
    expect(wrapper.text()).toContain('На последней странице новых уникальных видео нет')
    expect(wrapper.find('.load-more').exists()).toBe(true)
    expect(searchVideos).toHaveBeenCalledTimes(3)
  })
})

describe('real router leave and stale-completion protection', () => {
  it.each(['before', 'after'] as const)('cancels on channel navigation and guards ignored stale results arriving %s the newer completion', async completion => {
    const { wrapper, router, store, searchVideos, getChannel, getVideo } = await openSearch()
    await wrapper.get('#search-query').setValue('прежняя')
    await wrapper.get('.main-search').trigger('click')
    await flushPromises()
    const previous = store.response
    const older = deferred<SearchVideosResponse>()
    const newer = deferred<SearchVideosResponse>()
    searchVideos.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    await wrapper.get('#search-query').setValue('отменяемая')
    await wrapper.get('.main-search').trigger('click')
    const oldSignal = searchVideos.mock.calls[1]?.[1]?.signal
    const analysis = wrapper.get('.analysis-action')
    expect(analysis.attributes('href')).toBe('/channels/UC_stage6?videoId=video_stage6')
    expect(wrapper.get('.channel-name').attributes('href')).toBe(analysis.attributes('href'))
    await analysis.trigger('mouseenter')
    expect(getChannel).not.toHaveBeenCalled()
    expect(getVideo).not.toHaveBeenCalled()
    await analysis.trigger('click')
    // The first lazy route import may finish after a single microtask flush.
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('channel'))
    await flushPromises()
    expect(router.currentRoute.value.params.channelId).toBe('UC_stage6')
    expect(router.currentRoute.value.query.videoId).toBe('video_stage6')
    expect(wrapper.get('h1').text()).toBe('Анализ канала')
    expect(wrapper.text()).toContain('Исходное видео: video_stage6')
    expect(wrapper.text()).toContain('Подходящих видео в просмотренной части нет')
    expect(oldSignal?.aborted).toBe(true)
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
    expect(store.error).toBeNull()
    expect(store.response).toBe(previous)
    await wrapper.get('a.text-action').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('search')
    expect(wrapper.get('.applied-text').text()).toContain('«прежняя»')
    expect(searchVideos).toHaveBeenCalledTimes(2)
    await wrapper.get('#search-query').setValue('новейшая')
    await wrapper.get('.main-search').trigger('click')
    const newPending = store.pending
    const newSignal = searchVideos.mock.calls[2]?.[1]?.signal
    const stale = responseFor({ query: 'отменяемая' }, { videos: [{ ...video, title: 'Не показывать устаревшую карточку' }] })
    if (completion === 'before') {
      older.resolve(stale)
      await flushPromises()
      expect(store.pending).toBe(newPending)
      expect(store.busy).toBe(true)
      expect(wrapper.get('.results').attributes('aria-busy')).toBe('true')
      expect(store.response).toBe(previous)
      expect(newSignal?.aborted).toBe(false)
    }
    const latest = responseFor({ query: 'новейшая', limit: 50, period: 'all', duration_ranges: [] }, {
      videos: [{ ...video, title: 'Новейшая карточка' }],
    })
    newer.resolve(latest)
    await flushPromises()
    expect(store.response).toBe(latest)
    if (completion === 'after') {
      older.resolve(stale)
      await flushPromises()
    }
    expect(store.response).toBe(latest)
    expect(wrapper.get('.video-title').text()).toBe('Новейшая карточка')
    expect(wrapper.text()).not.toContain('Не показывать устаревшую карточку')
    expect(wrapper.get('.applied-text').text()).toContain('«новейшая»')
    expect(store.error).toBeNull()
    expect(store.pending).toBeNull()
    expect(store.busy).toBe(false)
    expect(searchVideos).toHaveBeenCalledTimes(3)
    expect(getChannel).not.toHaveBeenCalled()
    expect(getVideo).not.toHaveBeenCalled()
  })
})

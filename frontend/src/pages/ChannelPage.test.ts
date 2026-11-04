// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import { ApiError } from '../api'
import type { ApiClient, ChannelCardOut, VideoOut } from '../api'
import { createAppRouter } from '../router'
import { createChannelsStore } from '../stores/channels'
import { createSearchStore } from '../stores/search'
import { createSessionCacheStore } from '../stores/sessionCache'
import ChannelChart from '../features/channel/ChannelChart.vue'
import ChannelPage from './ChannelPage.vue'

vi.mock('../features/channel/ChannelChart.vue', () => ({ default: {
  name: 'ChannelChart', props: ['videos', 'median', 'sourceVideoId'], template: '<div class="chart-double" />',
} }))

const origin: VideoOut = { id: 'origin', title: 'Исходное видео', channel_id: 'UC_example',
  duration_seconds: 181, view_count: 0, published_at: '2026-01-01T00:00:00Z' }
function analysis(overrides: Partial<ChannelCardOut> = {}): ChannelCardOut {
  return { channel: { id: 'UC_example', title: 'Канал примера', subscriber_count: 0, video_count: 2 },
    sample: { selected_count: 2, metric_count: 2, uploads_scanned: 5, pages_scanned: 1,
      stop_reason: 'uploads_exhausted', target_reached: false, scan_limit_reached: false },
    metrics: { count: 2, median_views: 0.5, mean_views: 0.5, std_views: 0.5, spike_ratio: 2,
      consistency: 0.5, like_view_count: 0, comment_view_count: 0 },
    summary: 'Описание только этой выборки.', videos: [
      { ...origin, id: 'later', title: 'Позднее видео', view_count: 1, published_at: '2026-02-01T00:00:00Z' }, origin,
    ], fetched_at: '2026-02-02T12:00:00Z', ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let wrapper: VueWrapper | undefined
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected real transport'))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined
  document.body.replaceChildren()
  expect(fetchMock).not.toHaveBeenCalled()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function setup(options: { result?: ChannelCardOut; error?: unknown; pending?: Promise<ChannelCardOut>; source?: VideoOut; path?: string } = {}) {
  const pinia = createPinia()
  const cache = createSessionCacheStore()(pinia)
  const getChannel = vi.fn<ApiClient['getChannel']>().mockResolvedValue(options.result ?? analysis())
  if (options.error) getChannel.mockRejectedValue(options.error)
  if (options.pending) getChannel.mockReturnValueOnce(options.pending)
  const searchVideos = vi.fn<ApiClient['searchVideos']>().mockImplementation(async request => ({
    query: request.query ?? '', applied: request, videos: [options.source ?? origin],
    fetched_at: '2026-02-01T00:00:00Z', items_scanned: 1, matched_count: 1, quota_used_estimate: 0,
  }))
  const getVideo = vi.fn<ApiClient['getVideo']>()
  const api: ApiClient = { getChannel, searchVideos, getVideo }
  const channels = createChannelsStore(() => api, () => cache)(pinia)
  const search = createSearchStore(() => api, () => cache)(pinia)
  search.patchDraft({ query: 'Topic' })
  await search.search()
  const router = createAppRouter(createMemoryHistory())
  await router.push(options.path ?? '/channels/UC_example?videoId=origin')
  await router.isReady()
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router, channels, search, getChannel, searchVideos, getVideo, cache }
}
function button(text: string) {
  const found = wrapper!.findAll('button').find(candidate => candidate.text() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

describe('ChannelPage routed analysis', () => {
  it('loads exactly once, passes source context, and revisits the shared cache without extra work', async () => {
    const { wrapper, router, getChannel, getVideo, searchVideos } = await setup()
    expect(getChannel).toHaveBeenCalledExactlyOnceWith('UC_example', {
      forceSync: false, sourceVideoId: 'origin', signal: expect.any(AbortSignal),
    })
    expect(wrapper.get('h1').text()).toBe('Канал примера')
    expect(wrapper.get('.sample-rule').text()).toContain('строго длиннее 180 секунд')
    expect(wrapper.get('.sample-rule').text()).toContain('Отобрано: 2; с известными просмотрами: 2')
    expect(wrapper.get('.sample-rule').text()).toContain('Доступные загрузки закончились')
    await router.push('/')
    await flushPromises()
    await router.push('/channels/UC_example?videoId=later')
    await flushPromises()
    expect(getChannel).toHaveBeenCalledTimes(1)
    expect(searchVideos).toHaveBeenCalledTimes(1)
    expect(getVideo).not.toHaveBeenCalled()
  })

  it('shows an accessible loading status and decorative skeleton until the first response', async () => {
    const task = deferred<ChannelCardOut>()
    const { wrapper, channels, getChannel } = await setup({ pending: task.promise })
    expect(channels.pending).toBe(true)
    expect(wrapper.get('section[aria-labelledby="page-title"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.loading-note').attributes('role')).toBe('status')
    expect(wrapper.get('.analysis-skeleton').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('.metrics-grid').exists()).toBe(false)
    expect(getChannel).toHaveBeenCalledTimes(1)
    task.resolve(analysis())
    await flushPromises()
    expect(wrapper.find('.analysis-skeleton').exists()).toBe(false)
    expect(channels.pending).toBe(false)
  })

  it.each([
    { error: new ApiError('Квота закончилась.', { code: 'quota_exceeded', status: 429, retryable: false }), title: 'Квота YouTube исчерпана' },
    { error: new ApiError('Канал не найден.', { code: 'not_found', status: 404 }), title: 'Канал недоступен' },
    { error: new Error('Private implementation detail'), title: 'Не удалось получить анализ' },
  ])('renders $title and retries only explicitly with non-force initial semantics', async ({ error, title }) => {
    const { wrapper, getChannel } = await setup({ error })
    expect(wrapper.get('[role="alert"] h2').text()).toBe(title)
    expect(wrapper.text()).not.toContain('Private implementation detail')
    expect(wrapper.find('.chart-double').exists()).toBe(false)
    expect(getChannel).toHaveBeenCalledTimes(1)
    getChannel.mockResolvedValueOnce(analysis())
    await button('Повторить запрос').trigger('click')
    await flushPromises()
    expect(getChannel).toHaveBeenCalledTimes(2)
    expect(getChannel.mock.calls[1]?.[1]?.forceSync).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('h1').text()).toBe('Канал примера')
  })

  it('preserves old data and timestamp through failed refresh and retries with forceSync true', async () => {
    const { wrapper, getChannel, channels } = await setup()
    const old = channels.response
    const task = deferred<ChannelCardOut>()
    getChannel.mockReturnValueOnce(task.promise)
    await button('Обновить данные').trigger('click')
    expect(button('Обновить данные').element.disabled).toBe(true)
    expect(wrapper.get('.loading-note').text()).toContain('ранее полученные данные')
    expect(wrapper.find('.analysis-skeleton').exists()).toBe(false)
    expect(wrapper.get('h1').text()).toBe('Канал примера')
    task.reject(new ApiError('Сервис недоступен.', { code: 'source_unavailable' }))
    await flushPromises()
    expect(channels.response).toEqual(old)
    expect(wrapper.text()).toContain('02.02.2026')
    expect(wrapper.get('[role="alert"]').text()).toContain('Предыдущий успешный анализ')
    getChannel.mockResolvedValueOnce(analysis({ channel: { id: 'UC_example', title: 'Обновлённый канал' } }))
    await button('Повторить запрос').trigger('click')
    await flushPromises()
    expect(getChannel.mock.calls.map(([, options]) => options?.forceSync)).toEqual([false, true, true])
    expect(wrapper.get('h1').text()).toBe('Обновлённый канал')
  })

  it.each([
    { label: 'included', source: origin, expected: 'входит в выборку.', included: true },
    { label: 'short', source: { ...origin, id: 'short', duration_seconds: 180 }, expected: 'не более 180 секунд', included: false },
    { label: 'unknown', source: { ...origin, id: 'unknown', duration_seconds: null }, expected: 'не входит в эту выборку', included: false },
    { label: 'mismatch absent from snapshot', source: { ...origin, id: 'other', channel_id: 'UC_other' }, expected: 'не входит в эту выборку', included: false },
    { label: 'snapshot membership overrides inconsistent search channel', source: { ...origin, channel_id: 'UC_other' }, expected: 'входит в выборку.', included: true },
  ])('explains $label source without inventing a comparison', async ({ source, expected, included }) => {
    const { wrapper } = await setup({ source, path: `/channels/UC_example?videoId=${source.id}` })
    expect(wrapper.get('.source-context').text()).toContain(expected)
    expect(wrapper.getComponent(ChannelChart).props('sourceVideoId')).toBe(included ? source.id : undefined)
    expect(wrapper.findAll('.is-source')).toHaveLength(included ? 1 : 0)
    if (!included) expect(wrapper.get('.source-context').text()).toContain('Сравнение с медианой не выполняется')
  })

  it.each([
    { status: 'duration_unknown' as const, expected: 'Длительность видео из поиска неизвестна' },
    { status: 'channel_mismatch' as const, expected: 'относится к другому каналу' },
    { status: 'duration_too_short' as const, expected: 'не более 180 секунд' },
  ])('uses safe backend source status $status without displaying raw reasons', async ({ status, expected }) => {
    const { wrapper } = await setup({ path: '/channels/UC_example?videoId=excluded',
      result: analysis({ source_video: { id: 'excluded', status, reason: '<script>private reason</script>' } }) })
    expect(wrapper.get('.source-context').text()).toContain(expected)
    expect(wrapper.get('.source-context').text()).toContain('Сравнение с медианой')
    expect(wrapper.text()).not.toContain('private reason')
    expect(wrapper.getComponent(ChannelChart).props('sourceVideoId')).toBeUndefined()
  })

  it('shows an empty bounded sample with no chart or numeric metrics', async () => {
    const { wrapper } = await setup({ result: analysis({ videos: [], metrics: { count: 0 },
      sample: { selected_count: 0, metric_count: 0, uploads_scanned: 200, pages_scanned: 4,
        stop_reason: 'scan_limit', target_reached: false, scan_limit_reached: true } }) })
    expect(wrapper.text()).toContain('Подходящих видео в просмотренной части нет')
    expect(wrapper.text()).toContain('не означает отсутствия подходящих видео на всём канале')
    expect(wrapper.text()).toContain('Достигнут предел просмотра загрузок')
    expect(wrapper.findComponent(ChannelChart).exists()).toBe(false)
    expect(wrapper.find('.metrics-grid').exists()).toBe(false)
  })

  it.each([0, 0.5])('keeps known zero counts and the exact median %s available to the chart', async median => {
    const { wrapper } = await setup({ result: analysis({ metrics: { count: 2, median_views: median, spike_ratio: median ? 2 : null } }) })
    expect(wrapper.get('.channel-facts dd').text()).toBe('0')
    expect(wrapper.get('.metrics-grid dd').text()).toBe(median ? '0,5' : '0')
    expect(wrapper.getComponent(ChannelChart).props('median')).toBe(median)
    expect(wrapper.get('tbody').text()).toContain('0')
    expect(wrapper.get('.sample-ratio').text()).toContain(median ? '0×' : '—')
  })

  it('cautions about one observation without implying repeatability', async () => {
    const { wrapper } = await setup({ result: analysis({ videos: [origin], metrics: { count: 1, median_views: 0 },
      sample: { ...analysis().sample, selected_count: 1, metric_count: 1 } }) })
    expect(wrapper.text()).toContain('Одно наблюдение не показывает повторяемость')
    expect(wrapper.text()).toContain('не перспективность ниши или будущий рост')
  })

  it('keeps unknown views as unknown and provides raw data without a chart', async () => {
    const { wrapper } = await setup({ result: analysis({ videos: [{ ...origin, view_count: null }],
      metrics: { count: 0, median_views: null }, sample: { ...analysis().sample, selected_count: 1, metric_count: 0 } }) })
    expect(wrapper.text()).toContain('В выборке нет известных просмотров')
    expect(wrapper.get('.metrics-grid dd').text()).toBe('Нет данных')
    expect(wrapper.findComponent(ChannelChart).exists()).toBe(false)
    expect(wrapper.get('tbody tr td:last-child').text()).toBe('Нет данных')
  })

  it('opens raw table and extra metrics independently and keeps external links safe', async () => {
    const { wrapper, getChannel } = await setup()
    const [raw, extra] = wrapper.findAll<HTMLDetailsElement>('details.analysis-details')
    if (!raw || !extra) throw new Error('Missing independent disclosures')
    expect(raw.element.open).toBe(false)
    expect(extra.element.open).toBe(false)
    await raw.get('summary').trigger('click')
    expect(raw.element.open).toBe(true)
    expect(extra.element.open).toBe(false)
    await extra.get('summary').trigger('click')
    await raw.get('summary').trigger('click')
    expect(raw.element.open).toBe(false)
    expect(extra.element.open).toBe(true)
    expect(wrapper.findAll('tbody th').map(row => row.text())).toEqual(['Исходное видеоВидео из поиска', 'Позднее видео'])
    for (const link of wrapper.findAll('a[target="_blank"]')) {
      expect(link.attributes('rel')).toBe('noopener noreferrer')
      expect(link.attributes('href')).toMatch(/^https:\/\/www\.youtube\.com\/(channel\/|watch\?v=)/)
      expect(link.attributes('aria-label')).toContain('новая вкладка')
    }
    expect(getChannel).toHaveBeenCalledTimes(1)
  })

  it.each(['before', 'after'] as const)('reuses the routed component, aborts the old channel, and ignores late answers arriving %s', async completion => {
    const older = deferred<ChannelCardOut>()
    const newer = deferred<ChannelCardOut>()
    const { wrapper, router, getChannel, channels } = await setup({ pending: older.promise })
    const page = wrapper.getComponent(ChannelPage).vm.$.uid
    const signal = getChannel.mock.calls[0]?.[1]?.signal
    getChannel.mockReturnValueOnce(newer.promise)
    await router.push('/channels/UC_new?videoId=origin')
    await flushPromises()
    expect(wrapper.getComponent(ChannelPage).vm.$.uid).toBe(page)
    expect(signal?.aborted).toBe(true)
    expect(getChannel).toHaveBeenCalledTimes(2)
    if (completion === 'before') {
      older.resolve(analysis())
      await flushPromises()
      expect(channels.pending).toBe(true)
      expect(wrapper.text()).not.toContain('Канал примера')
    }
    newer.resolve(analysis({ channel: { id: 'UC_new', title: 'Новый канал' } }))
    await flushPromises()
    older.resolve(analysis())
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Новый канал')
    expect(channels.channelId).toBe('UC_new')
    expect(channels.error).toBeNull()
    expect(channels.pending).toBe(false)
  })

  it('updates source-only query context without reloading and restores the original search', async () => {
    const { wrapper, router, search, searchVideos, getChannel } = await setup()
    search.patchDraft({ query: 'Unapplied draft' })
    search.setSort('views')
    const previous = search.response
    await router.push('/channels/UC_example?videoId=later')
    await flushPromises()
    expect(wrapper.getComponent(ChannelChart).props('sourceVideoId')).toBe('later')
    expect(getChannel).toHaveBeenCalledTimes(1)
    await wrapper.get('a.back-link').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('search')
    expect(wrapper.get('h1').text()).toBe('Поиск видео')
    expect(search.response).toBe(previous)
    expect(search.draft.query).toBe('Unapplied draft')
    expect(search.sortMode).toBe('views')
    expect(wrapper.get('.video-title').text()).toBe(origin.title)
    expect(searchVideos).toHaveBeenCalledTimes(1)
  })
})

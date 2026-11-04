import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { VideoOut } from '../../api'
import VideoCard from './VideoCard.vue'

const mounted: VueWrapper[] = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

const video: VideoOut = {
  id: 'video_1', title: 'Длинное название видео для проверки полной доступной подписи',
  channel_id: 'UC_channel', channel_title: 'Название канала',
  channel_subscriber_count: 24000, view_count: 288000, view_sub_ratio: 12,
  duration_seconds: 1122, published_at: '2026-10-30T10:00:00Z',
  thumbnail_url: 'https://i.ytimg.com/vi/video_1/hqdefault.jpg',
}

async function card(overrides: Partial<VideoOut> = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'search', component: { template: '<div />' } },
    { path: '/channels/:channelId', name: 'channel', component: { template: '<div />' } },
  ] })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(VideoCard, { props: { video: { ...video, ...overrides } }, global: { plugins: [router] } })
  mounted.push(wrapper)
  return wrapper
}

describe('video cards', () => {
  it('separates safe external video links from internal channel actions', async () => {
    const wrapper = await card()
    const external = wrapper.findAll('a[target="_blank"]')
    expect(external).toHaveLength(2)
    for (const link of external) {
      expect(link.attributes('href')).toBe('https://www.youtube.com/watch?v=video_1')
      expect(link.attributes('rel')).toBe('noopener noreferrer')
      expect(link.attributes('aria-label')).toContain('новая вкладка')
    }
    expect(wrapper.get('.analysis-action').attributes('href')).toBe('/channels/UC_channel?videoId=video_1')
    expect(wrapper.get('.channel-name').attributes('href')).toBe('/channels/UC_channel?videoId=video_1')
    expect(wrapper.find('a a').exists()).toBe(false)
    expect(wrapper.get('.ratio-badge').attributes('data-intensity')).toBe('high')
  })

  it('retains exact full data without requiring hover', async () => {
    const wrapper = await card()
    expect(wrapper.get('details').text()).toContain(video.title)
    expect(wrapper.get('details').text().replace(/[\u00a0\u202f]/g, ' ')).toContain('288 000')
    expect(wrapper.get('details').text()).toContain('30.10.2026')
    expect(wrapper.get('.video-duration').text()).toBe('18:42')
  })

  it('falls back after a missing or failed real image', async () => {
    const wrapper = await card()
    expect(wrapper.get('img').attributes('loading')).toBe('lazy')
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('Превью недоступно')
    const missing = await card({ thumbnail_url: null, duration_seconds: null })
    expect(missing.text()).toContain('Нет длительности')
  })

  it('does not claim subscriber hiding when only data is absent', async () => {
    const wrapper = await card({ channel_subscriber_count: null, channel_subscriber_count_hidden: null, view_sub_ratio: null })
    expect(wrapper.text()).toContain('Нет данных')
    expect(wrapper.text()).not.toContain('Подписчики скрыты')
    expect(wrapper.get('.ratio-number').text()).toBe('—')
    expect(wrapper.get('.ratio-badge').attributes('data-intensity')).toBe('unknown')
  })

  it('keeps a confirmed hidden count hidden even in full details', async () => {
    const wrapper = await card({ channel_subscriber_count_hidden: true, channel_subscriber_count: 56789 })
    expect(wrapper.text()).toContain('Подписчики скрыты')
    expect(wrapper.text()).not.toMatch(/56[\s\u00a0\u202f]?789/)
    expect(wrapper.get('.ratio-number').text()).toBe('—')
  })

  it('keeps zero views visible, but not a ratio with zero subscribers', async () => {
    const wrapper = await card({ view_count: 0, channel_subscriber_count: 0, view_sub_ratio: null, duration_seconds: 0 })
    expect(wrapper.get('.video-duration').text()).toBe('0:00')
    expect(wrapper.get('.ratio-number').text()).toBe('—')
    expect(wrapper.get('.video-metadata').text()).toContain('Просмотры:0')
  })

  it('does not invent channel actions or accept active image URL schemes', async () => {
    const wrapper = await card({ channel_id: null, channel_title: null, thumbnail_url: 'javascript:alert(1)' })
    expect(wrapper.find('.analysis-action').exists()).toBe(false)
    expect(wrapper.text()).toContain('Канал для анализа неизвестен')
    expect(wrapper.text()).toContain('Название канала недоступно')
    expect(wrapper.find('img').exists()).toBe(false)
  })
})

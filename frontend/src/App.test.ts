import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import App from './App.vue'
import { createAppRouter, routes } from './router'
import { navigation } from './router/navigation'

const mounted: VueWrapper[] = []
const fetchSpy = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function openPage(path: string) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [createPinia(), router] },
  })
  mounted.push(wrapper)
  await flushPromises()
  await nextTick()
  return { wrapper, router }
}

describe('frontend foundation', () => {
  it('opens the search shell without automatically calling the API', async () => {
    const { wrapper } = await openPage('/')
    expect(wrapper.get('h1').text()).toBe('Поиск видео')
    expect(wrapper.text()).toContain('Поиск ещё не подключён')
    expect(wrapper.get('nav').attributes('aria-label')).toBe('Основная навигация')
    expect(wrapper.get('.nav-link').attributes('aria-current')).toBe('page')
    expect(document.title).toBe('Поиск видео · Аналитика тем')
    expect(document.activeElement?.id).toBe('page-title')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses only the centralized search item in top navigation', async () => {
    const { wrapper } = await openPage('/')
    expect(navigation).toEqual([{ label: 'Поиск видео', routeName: 'search' }])
    expect(wrapper.findAll('.nav-link')).toHaveLength(1)
    expect(routes.map(route => route.name)).toEqual(['search', 'channel', 'not-found'])
    expect(wrapper.find('a[href="/settings"]').exists()).toBe(false)
  })

  it('accepts a direct channel URL and optional video context without fetching data', async () => {
    const { wrapper, router } = await openPage('/channels/UC_sample?videoId=video_sample')
    expect(router.currentRoute.value.name).toBe('channel')
    expect(wrapper.get('h1').text()).toBe('Анализ канала')
    expect(wrapper.text()).toContain('UC_sample')
    expect(wrapper.text()).toContain('video_sample')
    expect(wrapper.text()).toContain('Анализ ещё не подключён')
    expect(wrapper.get('.nav-link').attributes('aria-current')).toBeUndefined()
    expect(document.title).toBe('Анализ канала · Аналитика тем')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['videoId=%3Cscript%3E', 'videoId=one&videoId=two', 'videoId='])('does not treat invalid source context as a video ID: %s', async query => {
    const { wrapper } = await openPage(`/channels/UC_sample?${query}`)
    expect(wrapper.text()).not.toContain('Исходное видео:')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns from a channel to search and focuses the new page heading', async () => {
    const { wrapper, router } = await openPage('/channels/UC_sample')
    await wrapper.get('a.text-action').trigger('click')
    await flushPromises()
    await nextTick()
    expect(router.currentRoute.value.name).toBe('search')
    expect(wrapper.get('h1').text()).toBe('Поиск видео')
    expect(document.activeElement?.id).toBe('page-title')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps a keyboard skip link to the main content', async () => {
    const { wrapper } = await openPage('/')
    await wrapper.get('.skip-link').trigger('click')
    expect(document.activeElement?.id).toBe('main-content')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['/settings', '/videos/example', '/channels/invalid%20id'])('shows a technical not-found state for %s', async path => {
    const { wrapper, router } = await openPage(path)
    expect(router.currentRoute.value.name).toBe('not-found')
    expect(wrapper.get('h1').text()).toBe('Страница не найдена')
    expect(wrapper.get('a.text-action').text()).toBe('К поиску')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

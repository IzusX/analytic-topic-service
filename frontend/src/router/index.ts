import { createRouter, createWebHistory } from 'vue-router'
import type { RouterHistory, RouteRecordRaw } from 'vue-router'

const idPattern = /^[A-Za-z0-9_-]{1,64}$/

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'search',
    component: () => import('../pages/SearchPage.vue'),
    meta: { title: 'Поиск видео' },
  },
  {
    path: '/channels/:channelId([A-Za-z0-9_-]{1,64})',
    name: 'channel',
    component: () => import('../pages/ChannelPage.vue'),
    props: route => ({
      channelId: route.params.channelId,
      sourceVideoId: typeof route.query.videoId === 'string' && idPattern.test(route.query.videoId)
        ? route.query.videoId
        : undefined,
    }),
    meta: { title: 'Анализ канала' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../pages/NotFoundPage.vue'),
    meta: { title: 'Страница не найдена' },
  },
]

export function createAppRouter(history: RouterHistory = createWebHistory(import.meta.env.BASE_URL)) {
  return createRouter({
    history,
    routes,
    // Context-aware restoration is implemented with the search store in a later stage.
    scrollBehavior: () => ({ top: 0 }),
  })
}

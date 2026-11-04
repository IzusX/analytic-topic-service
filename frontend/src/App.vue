<script setup lang="ts">
import { nextTick, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { NConfigProvider, NGlobalStyle, darkTheme, ruRU, dateRuRU } from 'naive-ui'
import AppHeader from './components/AppHeader.vue'
import { naiveTheme, themeVariables } from './styles/theme'

const route = useRoute()

watch(
  () => route.fullPath,
  async () => {
    const title = typeof route.meta.title === 'string' ? route.meta.title : 'Аналитика тем'
    document.title = `${title} · Аналитика тем`
    await nextTick()
    document.getElementById('page-title')?.focus({ preventScroll: true })
  },
  { immediate: true, flush: 'post' },
)

function focusContent(event: MouseEvent) {
  event.preventDefault()
  document.getElementById('main-content')?.focus()
}
</script>

<template>
  <NConfigProvider
    :theme="darkTheme"
    :theme-overrides="naiveTheme"
    :locale="ruRU"
    :date-locale="dateRuRU"
    :style="themeVariables"
  >
    <NGlobalStyle />
    <div class="flex min-h-dvh flex-col">
      <a class="skip-link" href="#main-content" @click="focusContent">Перейти к содержимому</a>
      <AppHeader />
      <main
        id="main-content"
        class="mx-auto w-full max-w-[1408px] flex-1 px-4 py-8 sm:px-8"
        tabindex="-1"
      >
        <RouterView />
      </main>
    </div>
  </NConfigProvider>
</template>

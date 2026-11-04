<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { NEmpty } from 'naive-ui'
import { useSearchStore } from '../stores/search'

const search = useSearchStore()

defineProps<{
  channelId: string
  sourceVideoId?: string
}>()
</script>

<template>
  <section aria-labelledby="page-title">
    <RouterLink class="text-action mb-4" :to="{ name: 'search' }">{{ search.response ? 'К результатам поиска' : 'К поиску' }}</RouterLink>
    <h1 id="page-title" class="page-title" tabindex="-1">Анализ канала</h1>
    <p class="page-description">Выборка видео и описательные показатели канала.</p>
    <dl class="route-context">
      <div><dt>Идентификатор канала:</dt><dd><code>{{ channelId }}</code></dd></div>
      <div v-if="sourceVideoId"><dt>Исходное видео:</dt><dd><code>{{ sourceVideoId }}</code></dd></div>
    </dl>
    <section class="empty-surface" aria-labelledby="channel-placeholder-title">
      <h2 id="channel-placeholder-title">Анализ ещё не подключён</h2>
      <NEmpty :show-icon="false" description="Показатели и график появятся после подключения экрана анализа." />
    </section>
  </section>
</template>

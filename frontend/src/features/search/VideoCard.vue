<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { VideoOut } from '../../api'
import { analyticalColors } from '../../styles/theme'
import { formatCompactCount, formatDuration, formatExactCount, formatRatio, formatUtcDate, isResourceId, knownRatio, noData, ratioLevel, thumbnailUrl } from '../../utils/presentation'

const props = defineProps<{ video: VideoOut }>()
const imageFailed = ref(false)
const title = computed(() => props.video.title || 'Название недоступно')
const image = computed(() => thumbnailUrl(props.video.thumbnail_url))
watch(() => [props.video.id, image.value], () => { imageFailed.value = false })
const videoUrl = computed(() => isResourceId(props.video.id) ? `https://www.youtube.com/watch?v=${encodeURIComponent(props.video.id)}` : undefined)
const channelRoute = computed(() => isResourceId(props.video.channel_id)
  ? { name: 'channel', params: { channelId: props.video.channel_id }, query: isResourceId(props.video.id) ? { videoId: props.video.id } : {} }
  : undefined)
const channelTitle = computed(() => props.video.channel_title || 'Название канала недоступно')
const ratio = computed(() => knownRatio(props.video))
const intensity = computed(() => analyticalColors[ratioLevel(ratio.value)])
const subscribers = computed(() => props.video.channel_subscriber_count_hidden === true
  ? 'Подписчики скрыты'
  : formatCompactCount(props.video.channel_subscriber_count))
const exactSubscribers = computed(() => props.video.channel_subscriber_count_hidden === true
  ? 'Подписчики скрыты'
  : formatExactCount(props.video.channel_subscriber_count))
const duration = computed(() => formatDuration(props.video.duration_seconds))
</script>

<template>
  <article class="video-card">
    <component
      :is="videoUrl ? 'a' : 'div'"
      class="video-thumbnail"
      :href="videoUrl"
      :target="videoUrl ? '_blank' : undefined"
      :rel="videoUrl ? 'noopener noreferrer' : undefined"
      :aria-label="videoUrl ? `${title} — оригинал YouTube, новая вкладка` : undefined"
    >
      <img v-if="image && !imageFailed" :src="image" alt="" width="480" height="270" loading="lazy" decoding="async" @error="imageFailed = true" />
      <span v-else class="thumbnail-fallback">Превью недоступно</span>
      <span class="video-duration" :aria-label="`Длительность: ${duration}`">{{ duration === noData ? 'Нет длительности' : duration }}</span>
    </component>
    <div class="video-body">
      <div class="ratio-badge" :data-intensity="ratioLevel(ratio)" :style="{ backgroundColor: intensity.background, color: intensity.text }" aria-describedby="ratio-explanation">
        <strong class="ratio-number">{{ formatRatio(ratio) }}</strong>
        <span>просмотры / подписчики</span>
      </div>
      <h3>
        <a v-if="videoUrl" :href="videoUrl" target="_blank" rel="noopener noreferrer" :aria-label="`${title} — оригинал YouTube, новая вкладка`" class="video-title">{{ title }}</a>
        <span v-else class="video-title">{{ title }}</span>
      </h3>
      <RouterLink v-if="channelRoute" class="channel-name" :to="channelRoute">{{ channelTitle }}</RouterLink>
      <p v-else class="channel-name">{{ channelTitle }}</p>
      <dl class="video-metadata">
        <div><dt>Подписчики:</dt><dd>{{ subscribers }}</dd></div>
        <div><dt>Просмотры:</dt><dd>{{ formatCompactCount(video.view_count) }}</dd></div>
        <div><dt>Публикация:</dt><dd>{{ formatUtcDate(video.published_at) }}</dd></div>
      </dl>
      <details class="video-details">
        <summary>Полные данные</summary>
        <p class="full-title">{{ title }}</p>
        <dl>
          <div><dt>Просмотры:</dt><dd>{{ formatExactCount(video.view_count) }}</dd></div>
          <div><dt>Подписчики:</dt><dd>{{ exactSubscribers }}</dd></div>
          <div><dt>Публикация:</dt><dd>{{ formatUtcDate(video.published_at, true) }}</dd></div>
          <div><dt>Длительность:</dt><dd>{{ duration }}</dd></div>
          <div><dt>Просмотры / подписчики:</dt><dd>{{ ratio === null ? '—' : String(ratio).replace('.', ',') + '×' }}</dd></div>
        </dl>
      </details>
      <RouterLink v-if="channelRoute" class="analysis-action" :to="channelRoute">Анализ канала</RouterLink>
      <p v-else class="analysis-unavailable">Канал для анализа неизвестен</p>
    </div>
  </article>
</template>

<style scoped>
.video-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--app-divider);
  border-radius: var(--app-radius-surface);
  background: var(--app-surface);
}
.video-thumbnail {
  position: relative;
  display: flex;
  aspect-ratio: 16 / 9;
  align-items: center;
  justify-content: center;
  background: var(--app-raised);
  color: var(--app-muted);
  text-decoration: none;
}
.video-thumbnail:focus-visible { outline-offset: -4px; }
.video-thumbnail img { width: 100%; height: 100%; object-fit: cover; }
.thumbnail-fallback { padding: 16px; text-align: center; }
.video-duration {
  position: absolute;
  right: 8px;
  bottom: 8px;
  max-width: calc(100% - 16px);
  padding: 2px 6px;
  border-radius: 4px;
  background: #17181ce6;
  color: var(--app-text);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.video-body { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.ratio-badge { display: flex; align-items: center; gap: 8px; width: fit-content; max-width: 100%; padding: 5px 10px; border-radius: 6px; font-size: 13px; }
.ratio-number { font-size: 15px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
h3 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.5; }
.video-title { display: -webkit-box; min-height: 48px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; color: var(--app-text); text-decoration: none; overflow-wrap: anywhere; }
.video-title:hover, .channel-name:hover { color: var(--app-accent-hover); }
.channel-name { display: inline-flex; min-height: 44px; align-items: center; color: var(--app-text); font-size: 14px; text-decoration: underline; overflow-wrap: anywhere; }
p.channel-name { margin: 0; text-decoration: none; }
.video-metadata, .video-details dl { display: grid; gap: 4px; margin: 0; color: var(--app-muted); font-size: 13px; }
dl div { display: flex; flex-wrap: wrap; gap: 5px; }
dd { margin: 0; min-width: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.video-details { color: var(--app-muted); font-size: 13px; }
.video-details summary { display: flex; min-height: 44px; align-items: center; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
.video-details[open] summary { margin-bottom: 8px; }
.full-title { margin: 0 0 8px; color: var(--app-text); overflow-wrap: anywhere; }
.analysis-action { display: flex; min-height: 44px; align-items: center; justify-content: center; margin-top: auto; padding: 8px 12px; border: 1px solid var(--app-border); border-radius: var(--app-radius-control); color: var(--app-accent); font-weight: 600; text-decoration: none; }
.analysis-action:hover { background: var(--app-raised); color: var(--app-accent-hover); }
.analysis-unavailable { margin: 0; color: var(--app-muted); font-size: 13px; }
</style>

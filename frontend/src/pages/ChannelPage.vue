<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, onBeforeRouteLeave } from 'vue-router'
import { NButton } from 'naive-ui'
import { useSearchStore } from '../stores/search'
import { useChannelsStore } from '../stores/channels'
import SearchIcon from '../features/search/SearchIcon.vue'
import ChannelChart from '../features/channel/ChannelChart.vue'
import { formatMetric, formatPercent, orderedVideos, sourceContext } from '../features/channel/analytics'
import { formatDuration, formatExactCount, formatRatio, formatUtcDate, isKnownCount, isResourceId, thumbnailUrl } from '../utils/presentation'
import type { VideoOut } from '../api'

const props = defineProps<{ channelId: string; sourceVideoId?: string }>()
const search = useSearchStore()
const channels = useChannelsStore()
const analysis = computed(() => channels.channelId === props.channelId ? channels.response : null)
const videos = computed(() => orderedVideos(analysis.value?.videos ?? []))
const source = computed(() => search.sourceVideos.find(video => video.id === props.sourceVideoId))
const context = computed(() => analysis.value ? sourceContext(analysis.value, props.sourceVideoId, source.value) : null)
const avatarFailed = ref(false)
const avatar = computed(() => thumbnailUrl(analysis.value?.channel.thumbnail_url))
const channelUrl = computed(() => `https://www.youtube.com/channel/${encodeURIComponent(props.channelId)}`)
const stopMessage = computed(() => {
  const sample = analysis.value?.sample
  if (!sample) return ''
  return sample.stop_reason === 'scan_limit'
    ? 'Достигнут предел просмотра загрузок. Выборка ограничена доступной просмотренной частью.'
    : sample.stop_reason === 'uploads_exhausted'
      ? 'Доступные загрузки закончились. Показаны найденные подходящие видео.'
      : 'Достигнут лимит выборки — 30 подходящих видео. Следующие страницы загрузок не запрашивались.'
})
const errorTitle = computed(() => channels.error?.status === 404 || channels.error?.code === 'not_found'
  ? 'Канал недоступен' : channels.error?.code === 'quota_exceeded' ? 'Квота YouTube исчерпана' : 'Не удалось получить анализ')
let failedRefresh = false
function load(forceSync = false) {
  failedRefresh = forceSync
  return channels.load(props.channelId, { forceSync, ...(props.sourceVideoId ? { sourceVideoId: props.sourceVideoId } : {}) })
}
watch(() => props.channelId, () => { avatarFailed.value = false; void load() }, { immediate: true })
onBeforeRouteLeave(() => { channels.cancel() })
function videoUrl(video: VideoOut) { return isResourceId(video.id) ? `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}` : undefined }
function medianRatio(video: VideoOut) {
  const median = analysis.value?.metrics.median_views
  return isKnownCount(video.view_count) && typeof median === 'number' && median > 0 ? video.view_count / median : null
}
</script>

<template>
  <section aria-labelledby="page-title" :aria-busy="channels.pending">
    <RouterLink class="text-action back-link" :to="{ name: 'search' }"><SearchIcon name="back" />{{ search.response ? 'К результатам поиска' : 'К поиску' }}</RouterLink>
    <div class="channel-heading">
      <div class="channel-identity">
        <img v-if="avatar && !avatarFailed" :src="avatar" alt="" width="64" height="64" class="channel-avatar" @error="avatarFailed = true" />
        <div><h1 id="page-title" class="page-title" tabindex="-1">{{ analysis?.channel.title || 'Анализ канала' }}</h1>
          <a class="text-action" :href="channelUrl" target="_blank" rel="noopener noreferrer" aria-label="Канал на YouTube, новая вкладка">Канал на YouTube<SearchIcon name="external" /></a>
        </div>
      </div>
      <NButton v-if="analysis" attr-type="button" :disabled="channels.pending" :loading="channels.pending" @click="load(true)"><template #icon><SearchIcon name="refresh" /></template>Обновить данные</NButton>
    </div>
    <p class="channel-note">Идентификатор канала: <code>{{ channelId }}</code></p>
    <p v-if="sourceVideoId" class="channel-note">Исходное видео: <code>{{ sourceVideoId }}</code></p>
    <p v-if="channels.persistenceWarning" class="channel-note" role="status">{{ channels.persistenceWarning }}</p>
    <p v-if="channels.pending" class="loading-note" role="status">{{ analysis ? 'Обновляем анализ. Ниже — ранее полученные данные.' : 'Загружаем выборку и показатели канала…' }}</p>
    <section v-if="channels.error" class="channel-error" role="alert">
      <h2>{{ errorTitle }}</h2><p>{{ channels.error.message }}</p>
      <p v-if="analysis">Предыдущий успешный анализ и время получения сохранены.</p>
      <NButton attr-type="button" :disabled="channels.pending" @click="load(failedRefresh)">Повторить запрос</NButton>
    </section>
    <template v-if="analysis">
      <p class="channel-note">Данные получены {{ formatUtcDate(analysis.fetched_at, true) }}. Обновление выполняется только по вашему действию.</p>
      <dl class="channel-facts">
        <div><dt>Подписчики</dt><dd>{{ analysis.channel.subscriber_count_hidden ? 'Подписчики скрыты' : formatExactCount(analysis.channel.subscriber_count) }}</dd></div>
        <div><dt>Всего видео канала</dt><dd>{{ formatExactCount(analysis.channel.video_count) }}</dd></div>
        <div><dt>Создан</dt><dd>{{ formatUtcDate(analysis.channel.published_at) }}</dd></div>
      </dl>
      <section class="sample-rule" aria-labelledby="sample-title">
        <h2 id="sample-title">Видео длительностью более 3 минут</h2>
        <p>До 30 последних доступных видео строго длиннее 180 секунд. Просматриваем не более 200 записей загрузок и четырёх страниц. Это правило длительности, не классификация формата видео.</p>
        <p>Отобрано: {{ analysis.sample.selected_count }}; с известными просмотрами: {{ analysis.sample.metric_count }}. Просмотрено загрузок: {{ analysis.sample.uploads_scanned }}, страниц: {{ analysis.sample.pages_scanned }}.</p>
        <p>Даты публикаций: {{ formatUtcDate(analysis.sample.date_from) }} — {{ formatUtcDate(analysis.sample.date_to) }}.</p>
        <p>{{ stopMessage }}</p>
        <p v-if="analysis.sample.unavailable_video_count || analysis.sample.unknown_duration_count || analysis.sample.excluded_duration_count || analysis.sample.unknown_date_count" class="channel-note">Недоступных записей: {{ analysis.sample.unavailable_video_count ?? 0 }}; без известной длительности: {{ analysis.sample.unknown_duration_count ?? 0 }}; исключено по длительности: {{ analysis.sample.excluded_duration_count ?? 0 }}; без даты: {{ analysis.sample.unknown_date_count ?? 0 }}.</p>
      </section>
      <p v-if="context?.message" class="source-context" role="status">{{ context.message }}</p>
      <section v-if="analysis.sample.selected_count === 0" class="empty-surface"><h2>Подходящих видео в просмотренной части нет</h2><p>Правило отбора и причина остановки указаны выше. Это не означает отсутствия подходящих видео на всём канале.</p></section>
      <template v-else>
        <dl class="metrics-grid" aria-label="Основные показатели">
          <div><dt>Медиана просмотров</dt><dd>{{ formatMetric(analysis.metrics.median_views) }}</dd><p>Середина упорядоченного набора известных просмотров.</p></div>
          <div><dt>Максимум / медиана</dt><dd>{{ formatRatio(analysis.metrics.spike_ratio) }}</dd><p>Отношение максимальных просмотров к медиане. При нулевой медиане не определено.</p></div>
          <div><dt>Доля ≥ половины медианы</dt><dd>{{ formatPercent(analysis.metrics.consistency) }}</dd><p>Доля видео с известными просмотрами не ниже половины медианы.</p></div>
          <div><dt>Учтено в метриках</dt><dd>{{ formatExactCount(analysis.metrics.count) }}</dd><p>Видео с известным числом просмотров, включая ноль.</p></div>
        </dl>
        <p class="descriptive-summary">{{ analysis.summary }}</p>
        <p class="channel-note">Показатели описывают эту выборку, не перспективность ниши или будущий рост.<template v-if="analysis.metrics.count === 1"> Одно наблюдение не показывает повторяемость.</template></p>
        <section aria-labelledby="views-chart-title" class="chart-section">
          <h2 id="views-chart-title">Просмотры видео выборки</h2>
          <p class="channel-note">От старых публикаций к новым; неизвестные даты — в конце. Это накопленные просмотры отдельных видео, не история роста канала.</p>
          <ChannelChart v-if="analysis.metrics.count > 0" :videos="videos" :median="analysis.metrics.median_views" :source-video-id="context?.included ? sourceVideoId : undefined" />
          <p v-else class="empty-surface">В выборке нет известных просмотров. График не построен; доступные исходные данные сохранены ниже.</p>
        </section>
        <details class="analysis-details"><summary>Показать исходные данные</summary>
          <div class="table-scroll" tabindex="0" role="region" aria-label="Исходные данные видео, таблица с горизонтальной прокруткой">
            <table><caption>Видео выборки: точные значения</caption><thead><tr><th scope="col">Видео</th><th scope="col">Публикация (UTC)</th><th scope="col">Длительность</th><th scope="col">Просмотры</th></tr></thead>
              <tbody><tr v-for="video in videos" :key="video.id"><th scope="row"><a v-if="videoUrl(video)" :href="videoUrl(video)" target="_blank" rel="noopener noreferrer" :aria-label="`${video.title} — YouTube, новая вкладка`">{{ video.title || 'Название недоступно' }}</a><span v-else>{{ video.title }}</span><span v-if="context?.included && video.id === sourceVideoId" class="source-label">Видео из поиска</span></th><td>{{ formatUtcDate(video.published_at, true) }}</td><td>{{ formatDuration(video.duration_seconds) }}</td><td>{{ formatExactCount(video.view_count) }}</td></tr></tbody>
            </table>
          </div>
        </details>
        <details class="analysis-details"><summary>Дополнительные показатели</summary>
          <dl class="extra-metrics">
            <div><dt>Среднее просмотров</dt><dd>{{ formatMetric(analysis.metrics.mean_views) }}</dd></div>
            <div><dt>Стандартное отклонение просмотров</dt><dd>{{ formatMetric(analysis.metrics.std_views) }}</dd></div>
            <div><dt>CV: отклонение / среднее</dt><dd>{{ formatMetric(analysis.metrics.cv, 2) }}</dd></div>
            <div><dt>Среднее лайки / просмотры</dt><dd>{{ formatPercent(analysis.metrics.avg_like_view) }} · учтено {{ formatExactCount(analysis.metrics.like_view_count) }}</dd></div>
            <div><dt>Среднее комментарии / просмотры</dt><dd>{{ formatPercent(analysis.metrics.avg_comment_view) }} · учтено {{ formatExactCount(analysis.metrics.comment_view_count) }}</dd></div>
          </dl><p class="channel-note">Отклонение рассчитано по всем известным значениям просмотров выбранных видео. CV не определён при нулевом среднем. Средние отношения учитывают только известные числители и положительные просмотры; неизвестные данные не заменяются нулём.</p>
        </details>
        <section class="sample-videos" aria-labelledby="sample-videos-title"><h2 id="sample-videos-title">Видео выборки</h2>
          <ol class="sample-video-list"><li v-for="video in videos" :key="video.id" :class="{ 'is-source': context?.included && video.id === sourceVideoId }">
            <div><span v-if="context?.included && video.id === sourceVideoId" class="source-label">Видео из поиска</span><a v-if="videoUrl(video)" :href="videoUrl(video)" target="_blank" rel="noopener noreferrer" :aria-label="`${video.title} — YouTube, новая вкладка`">{{ video.title || 'Название недоступно' }}</a><span v-else>{{ video.title }}</span><p class="channel-note">{{ formatUtcDate(video.published_at) }} · {{ formatDuration(video.duration_seconds) }} · просмотры: {{ formatExactCount(video.view_count) }}</p></div>
            <p class="sample-ratio">{{ formatRatio(medianRatio(video)) }}<span>просмотры / медиана выборки</span></p>
          </li></ol>
        </section>
      </template>
    </template>
    <div v-else-if="channels.pending" class="analysis-skeleton" aria-hidden="true"><div /><div /><div /></div>
  </section>
</template>

<style scoped>
.text-action { gap: 8px; }
.back-link { margin-bottom: 16px; }
.channel-heading .page-title { color: var(--app-text); }
.channel-heading, .channel-identity { display: flex; align-items: center; gap: 16px; min-width: 0; }
.channel-heading { justify-content: space-between; flex-wrap: wrap; }
.channel-identity { flex: 1; }
.channel-identity > div { min-width: 0; }
.channel-avatar { flex: none; border-radius: 50%; object-fit: cover; }
.page-title { overflow-wrap: anywhere; }
.channel-note { margin: 8px 0; font-size: 14px; line-height: 1.5; color: var(--app-muted); overflow-wrap: anywhere; }
.channel-facts, .metrics-grid, .extra-metrics { display: grid; gap: 20px; margin: 24px 0; }
.channel-facts { grid-template-columns: repeat(3, minmax(0,1fr)); }
dt { color: var(--app-muted); font-size: 14px; line-height: 1.5; }
dd { margin: 6px 0 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
h2 { font-size: 20px; line-height: 1.4; margin: 0 0 12px; }
.sample-rule { padding: 20px; margin-top: 28px; border: 1px solid var(--app-border); border-radius: var(--app-radius-surface); }
.sample-rule p, .channel-error p { line-height: 1.6; margin: 8px 0; }
.source-context { margin: 20px 0; line-height: 1.6; }
.metrics-grid { grid-template-columns: repeat(4,minmax(0,1fr)); padding: 24px 0; border-block: 1px solid var(--app-divider); }
.metrics-grid dd { font-size: 26px; font-weight: 600; }
.metrics-grid p { margin: 8px 0 0; color: var(--app-muted); font-size: 14px; line-height: 1.5; }
.descriptive-summary { line-height: 1.6; max-width: 75ch; }
.chart-section, .sample-videos { margin-top: 32px; }
.analysis-details { border-bottom: 1px solid var(--app-divider); padding: 12px 0; }
.analysis-details summary { display: flex; min-height: 44px; align-items: center; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
.table-scroll { overflow-x: auto; max-width: 100%; margin-block: 12px; }
table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 14px; }
caption { text-align: left; padding-bottom: 12px; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--app-divider); padding: 12px; }
th[scope=row] { max-width: 40ch; font-weight: 400; overflow-wrap: anywhere; }
a { color: var(--app-accent); }
.extra-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }
.sample-video-list { list-style: none; padding: 0; margin: 0; }
.sample-video-list li { display: flex; justify-content: space-between; gap: 20px; padding: 20px 0; border-bottom: 1px solid var(--app-divider); }
.sample-video-list li > div { min-width: 0; }
.sample-video-list a { display: inline-flex; min-height: 44px; align-items: center; overflow-wrap: anywhere; }
.sample-ratio { flex: none; margin: 0; text-align: right; font-size: 20px; font-variant-numeric: tabular-nums; }
.sample-ratio span { display: block; margin-top: 6px; font-size: 14px; color: var(--app-muted); }
.source-label { display: block; margin-block: 4px; font-size: 14px; color: var(--app-text); font-weight: 600; }
.is-source { background: var(--app-surface); }
.channel-error { margin-block: 20px; padding: 20px; border: 1px solid var(--app-border); border-radius: var(--app-radius-surface); }
.loading-note { margin-block: 20px; line-height: 1.5; }
.analysis-skeleton { display: grid; gap: 20px; margin-top: 24px; }
.analysis-skeleton div { height: 90px; border-radius: var(--app-radius-surface); background: var(--app-raised); }
@media (max-width: 800px) { .metrics-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media (max-width: 540px) { .channel-heading > .n-button { width: 100%; } .channel-facts, .extra-metrics { grid-template-columns: minmax(0,1fr); } .sample-video-list li { flex-direction: column; gap: 8px; } .sample-ratio { text-align: left; } }
@media (max-width: 359px) { .metrics-grid { grid-template-columns: minmax(0,1fr); } }
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { NButton } from 'naive-ui'
import { useSearchStore } from '../stores/search'
import SearchForm from '../features/search/SearchForm.vue'
import VideoCard from '../features/search/VideoCard.vue'
import SearchIcon from '../features/search/SearchIcon.vue'
import { criteriaKey, validateDraft } from '../features/search/model'
import { describeCriteria } from '../features/search/summary'
import { formatUtcDate } from '../utils/presentation'
import { sortOptions } from '../features/search/results'
import type { SortMode } from '../features/search/results'

const search = useSearchStore()
const form = ref<{ focusFirstError: () => Promise<void> } | null>(null)
const videos = computed(() => search.sortedVideos)
const paginationStatus = ref<HTMLElement | null>(null)
async function loadMore() {
  const button = document.activeElement
  await search.loadMore()
  await nextTick()
  // A terminal page removes the focused button; retain a useful keyboard position.
  if (button instanceof HTMLElement && !button.isConnected) paginationStatus.value?.focus({ preventScroll: true })
}
function changeSort(event: Event) {
  search.setSort((event.target as HTMLSelectElement).value as SortMode)
}
const pendingDraftChanges = computed(() => {
  if (!search.pending || search.pending.kind === 'more') return false
  const draft = validateDraft(search.draft)
  return !draft.valid || criteriaKey(draft.request) !== criteriaKey(search.pending.request)
})
const loadingMessage = computed(() => search.pending?.kind === 'more'
  ? 'Загружаем следующую страницу. Ранее полученные видео остаются.'
  : search.pending?.kind === 'refresh'
    ? 'Обновляем текущую выдачу. Ниже — ранее полученные данные.'
    : search.response ? 'Ищем по новым условиям. Ниже — предыдущая выдача.' : 'Ищем видео…')
const errorTitle = computed(() => search.error?.code === 'quota_exceeded'
  ? 'Квота YouTube исчерпана'
  : search.error?.code === 'source_rate_limited' ? 'Источник ограничил запросы'
    : search.error?.status === 422 ? 'Проверьте условия поиска' : 'Не удалось получить видео')

async function focusFieldErrors() {
  if (Object.keys(search.fieldErrors).length > 0) {
    await nextTick()
    await form.value?.focusFirstError()
  }
}
async function runSearch() {
  search.saveContext(window.scrollY)
  const succeeded = await search.search()
  await focusFieldErrors()
  if (succeeded) {
    await nextTick()
    window.scrollTo({ top: search.scrollY, behavior: 'instant' })
  }
}
async function retrySearch() {
  await search.retry()
  await focusFieldErrors()
}
function saveContext() { search.saveContext(window.scrollY) }
onMounted(() => { window.addEventListener('pagehide', saveContext) })
onUnmounted(() => { window.removeEventListener('pagehide', saveContext) })
onBeforeRouteLeave(to => {
  const videoId = to.name === 'channel' && typeof to.query.videoId === 'string' ? to.query.videoId : null
  search.saveContext(window.scrollY, videoId)
  search.cancel()
})
</script>

<template>
  <section aria-labelledby="page-title">
    <h1 id="page-title" class="page-title" tabindex="-1">Поиск видео</h1>
    <p v-if="search.persistenceWarning" class="helper" role="status">{{ search.persistenceWarning }}</p>
    <SearchForm ref="form" :draft="search.draft" :errors="search.fieldErrors" :busy="search.busy" @change="search.patchDraft" @submit="runSearch" @reset="search.resetFilters" />
    <p v-if="search.hasDraftChanges && (!search.busy || search.pending?.kind === 'more')" class="draft-notice" role="status">Параметры изменены. Нажмите «Искать», чтобы применить. Ниже — текущая выдача.</p>
    <p v-if="search.busy" class="request-status" role="status" aria-live="polite">{{ loadingMessage }}</p>
    <p v-if="pendingDraftChanges" class="helper">Изменения в форме не входят в выполняющийся запрос.</p>

    <section v-if="search.error" class="request-error" role="alert" aria-labelledby="search-error-title">
      <h2 id="search-error-title">{{ errorTitle }}</h2>
      <p>{{ search.error.message }}</p>
      <p v-if="search.response" class="helper">Ранее полученные видео и условия текущей выдачи сохранены.</p>
      <NButton v-if="search.canRetry" attr-type="button" :disabled="search.busy" @click="retrySearch">Повторить запрос</NButton>
      <p class="helper">Повтор использует условия неудавшегося запроса, не изменения формы.</p>
    </section>

    <section v-if="search.response" class="results" aria-label="Результаты поиска" :aria-busy="search.busy">
      <div class="results-toolbar">
        <h2 class="results-count">Загружено {{ videos.length }} видео</h2>
        <label class="sort-control" for="search-sort">Сортировка загруженных видео
          <select id="search-sort" :value="search.sortMode" @change="changeSort"><option v-for="option in sortOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select>
        </label>
      </div>
      <div class="applied-conditions">
        <div class="applied-text">
          <p><strong>Текущая выдача:</strong> {{ describeCriteria(search.response.applied) }}</p>
          <p class="helper">Последняя страница получена {{ formatUtcDate(search.response.fetched_at, true) }}</p>
          <p v-if="search.response.applied.published_after" class="helper">Начало периода: {{ formatUtcDate(search.response.applied.published_after, true) }}</p>
        </div>
        <NButton attr-type="button" :disabled="search.busy" @click="search.refresh"><template #icon><SearchIcon name="refresh" /></template>Обновить выдачу</NButton>
      </div>
      <p class="helper">Обновление использует текущие условия и пересчитывает период. Изменения формы не применяются.</p>
      <details class="ratio-explanation">
        <summary><SearchIcon name="info" />Как читать коэффициент</summary>
        <p id="ratio-explanation">Просмотры / текущие подписчики канала. Голубая интенсивность возрастает при значениях менее 1×, от 1 до 3×, от 3 до 10× и от 10×. Это числовой ориентир, не оценка качества или повторяемости успеха. «—» означает неопределённое отношение; «≈» — округление.</p>
      </details>
      <div v-if="videos.length > 0" class="video-grid">
        <VideoCard v-for="video in videos" :key="video.id" :video="video" />
      </div>
      <section v-else class="empty-surface" aria-labelledby="empty-results-title">
        <h2 id="empty-results-title">В просмотренной части выдачи совпадений нет</h2>
        <p>Из {{ search.totalItemsScanned }} проверенных кандидатов ни одно видео не подошло по условиям. Можно изменить фильтры и нажать «Искать».</p>
        <p v-if="search.response.next_page_token" class="helper">У источника есть продолжение: пустая обработанная страница не означает отсутствие совпадений на всём YouTube.</p>
      </section>
      <p v-if="search.lastAddedCount !== null" ref="paginationStatus" class="page-note" role="status" tabindex="-1">{{ search.lastAddedCount === 0 ? 'На последней странице новых уникальных видео нет.' : `Добавлено уникальных видео: ${search.lastAddedCount}.` }}</p>
      <div class="pagination-actions">
        <NButton v-if="search.canLoadMore || search.pending?.kind === 'more'" class="load-more" attr-type="button" :disabled="search.busy" :loading="search.pending?.kind === 'more'" @click="loadMore">Показать ещё</NButton>
        <p v-else-if="search.paginationStopped" class="page-note">Источник повторил токен продолжения. Догрузка остановлена, чтобы не запрашивать ту же страницу снова. Можно явно обновить выдачу.</p>
        <p v-else-if="!search.response.next_page_token" class="page-note">Конец доступной выдачи по текущим условиям.</p>
      </div>
      <p class="page-note">Обработано страниц: {{ search.pageCount }}; кандидатов: {{ search.totalItemsScanned }}; уникальных видео: {{ search.sourceVideos.length }}. Одна догрузка — одна страница до 50 кандидатов.</p>
      <p class="page-note">Сортировка применяется только к загруженным видео и не расходует API-квоту. Исходный порядок YouTube — по релевантности, не глобальные тренды.</p>
    </section>
    <div v-else-if="search.busy" class="video-grid first-load-skeleton" aria-hidden="true">
      <div v-for="index in 3" :key="index" class="skeleton-card"><div /><span /><span /><span /></div>
    </div>
    <section v-else class="empty-surface" aria-labelledby="initial-search-title">
      <h2 id="initial-search-title">Задайте условия и начните поиск</h2>
      <p>Введите тему или оставьте поле пустым. Фильтры применятся после нажатия «Искать». Автоматической загрузки нет.</p>
    </section>
  </section>
</template>

<style scoped>
.draft-notice, .request-status { margin: 16px 0 0; color: var(--app-text); line-height: 1.5; }
.draft-notice { padding: 12px 16px; border: 1px solid var(--app-border); border-radius: var(--app-radius-control); background: var(--app-raised); }
.helper, .page-note { margin: 6px 0 0; color: var(--app-muted); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.request-error { margin-top: 20px; padding: 16px; border: 1px solid #804e57; border-radius: var(--app-radius-surface); background: var(--app-surface); }
.request-error h2 { margin: 0 0 8px; font-size: 18px; color: #ffb4b8; }
.request-error > p { margin: 6px 0 12px; }
.results { margin-top: 24px; }
.results-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; margin-bottom: 12px; }
.results-count { margin: 0; font-size: 20px; font-weight: 600; }
.sort-control { min-width: 0; max-width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; color: var(--app-muted); font-size: 14px; }
.sort-control select { min-width: 0; max-width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid var(--app-border); border-radius: var(--app-radius-control); background: var(--app-page); color: var(--app-text); font: inherit; }
.pagination-actions { display: grid; justify-items: center; margin-top: 24px; }
.applied-conditions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; padding-bottom: 12px; border-bottom: 1px solid var(--app-divider); }
.applied-text { flex: 1; min-width: 0; }
.applied-text > p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
.applied-text .helper { margin-top: 4px; }
.ratio-explanation { margin: 4px 0 12px; font-size: 14px; color: var(--app-muted); }
.ratio-explanation summary { display: flex; min-height: 44px; align-items: center; gap: 8px; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
.ratio-explanation p { max-width: 85ch; margin-top: 8px; line-height: 1.5; }
.video-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 24px; }
.page-note { margin-top: 20px; }
.first-load-skeleton { margin-top: 28px; }
.skeleton-card { min-width: 0; padding-bottom: 16px; border: 1px solid var(--app-divider); border-radius: var(--app-radius-surface); overflow: hidden; background: var(--app-surface); }
.skeleton-card div { aspect-ratio: 16/9; background: var(--app-raised); }
.skeleton-card span { display: block; height: 18px; margin: 16px 16px 0; border-radius: 4px; background: var(--app-raised); }
.skeleton-card span:last-child { width: 55%; }
@media (min-width: 1560px) { .video-grid { grid-template-columns: repeat(4,minmax(0,1fr)); } }
@media (max-width: 1099px) { .video-grid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 20px; } }
@media (max-width: 639px) { .video-grid { grid-template-columns: minmax(0,1fr); } .applied-conditions > .n-button { width: 100%; } }
</style>

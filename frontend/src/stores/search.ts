import { defineStore } from 'pinia'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { isSearchResponse, searchCacheKey, useSessionCacheStore } from './sessionCache'
import type { SearchSnapshot } from './sessionCache'
import { ApiError, createConfiguredApiClient } from '../api'
import type { ApiClient, SearchVideosRequest, SearchVideosResponse, VideoOut } from '../api'
import { deduplicateVideos, sortOptions, sortVideos } from '../features/search/results'
import type { SortMode } from '../features/search/results'
import { createEmptyDraft, createRefreshRequest, criteriaKey, validateDraft } from '../features/search/model'
import type { SearchDraft, SearchDraftField, SearchErrors } from '../features/search/model'

type SearchAction = { kind: 'search' | 'refresh' | 'more'; request: SearchVideosRequest }

function isPageToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x20\x7f]/.test(value)
}

/** Compare all backend criteria, including API-only bounds; only continuation is excluded. */
function appliedKey(request: SearchVideosRequest): string {
  return JSON.stringify({
    query: request.query ?? '', limit: request.limit ?? 50, period: request.period ?? 'all',
    relevance_language: request.relevance_language ?? null,
    duration_ranges: [...(request.duration_ranges ?? [])].sort(),
    published_after: request.published_after ?? null, published_before: request.published_before ?? null,
    min_views: request.min_views ?? null, max_views: request.max_views ?? null,
    min_subscribers: request.min_subscribers ?? null, max_subscribers: request.max_subscribers ?? null,
  })
}

function copyRequest(request: SearchVideosRequest): SearchVideosRequest {
  const copy = { ...request }
  if (request.duration_ranges !== undefined) copy.duration_ranges = [...request.duration_ranges]
  return copy
}

function copyAction(action: SearchAction): SearchAction {
  return { kind: action.kind, request: copyRequest(action.request) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesAction(result: SearchVideosResponse, action: SearchAction): boolean {
  const expected = copyRequest(action.request)
  const applied = copyRequest(result.applied)
  // A first-page relative search may acquire a server-generated lower boundary.
  // Explicit bounds and all continuation bounds must still match exactly.
  if (action.kind !== 'more' && (expected.period ?? 'all') !== 'all' && !expected.published_after) {
    delete applied.published_after
  }
  return result.query === (expected.query ?? '') && appliedKey(applied) === appliedKey(expected)
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError'
}

const backendDraftFields = new Map<string, SearchDraftField>([
  ['query', 'query'],
  ['relevance_language', 'language'],
  ['min_subscribers', 'minSubscribers'],
  ['max_subscribers', 'maxSubscribers'],
  ['period', 'period'],
  ['duration_ranges', 'durationRanges'],
])

function validationErrors(error: ApiError): SearchErrors {
  const errors: SearchErrors = {}
  for (const { loc, message } of error.fields) {
    const [root, name, index] = loc
    if (root !== 'body' || typeof name !== 'string') continue
    if (loc.length !== 2
      && !(name === 'duration_ranges' && loc.length === 3 && typeof index === 'number')) continue
    const field = backendDraftFields.get(name)
    if (field !== undefined && errors[field] === undefined) errors[field] = message
  }
  return errors
}

export function createSearchStore(
  apiFactory: () => ApiClient = createConfiguredApiClient,
  cacheFactory?: () => ReturnType<typeof useSessionCacheStore>,
) {
  return defineStore('search', () => {
    const cache = cacheFactory?.()
    const draft = reactive<SearchDraft>(cache?.draft ? { ...cache.draft, durationRanges: [...cache.draft.durationRanges] } : createEmptyDraft())
    const response = shallowRef<SearchVideosResponse | null>(null)
    const sourceVideos = shallowRef<VideoOut[]>([])
    const sortMode = ref<SortMode>('original')
    const sortedVideos = computed(() => sortVideos(sourceVideos.value, sortMode.value))
    const pageCount = ref(0)
    const totalItemsScanned = ref(0)
    const totalQuotaUsedEstimate = ref(0)
    const lastAddedCount = ref<number | null>(null)
    const paginationStopped = ref(false)
    const consumedTokens = new Set<string>()
    const pending = shallowRef<SearchAction | null>(null)
    const error = shallowRef<ApiError | null>(null)
    const fieldErrors = ref<SearchErrors>({})
    const failedAction = shallowRef<SearchAction | null>(null)
    let controller: AbortController | null = null
    let requestId = 0
    let activeKey: string | null = cache?.activeSearchKey ?? null
    const scrollY = ref(0)
    const sourceVideoId = ref<string | null>(null)
    const persistenceWarning = computed(() => cache?.persistenceWarning ?? null)

    function restore(snapshot: SearchSnapshot): void {
      response.value = snapshot.response
      sourceVideos.value = snapshot.sourceVideos
      sortMode.value = snapshot.sortMode
      pageCount.value = snapshot.pageCount
      totalItemsScanned.value = snapshot.totalItemsScanned
      totalQuotaUsedEstimate.value = snapshot.totalQuotaUsedEstimate
      lastAddedCount.value = snapshot.lastAddedCount
      paginationStopped.value = snapshot.paginationStopped
      consumedTokens.clear()
      for (const token of snapshot.consumedTokens) consumedTokens.add(token)
      scrollY.value = snapshot.scrollY
      sourceVideoId.value = snapshot.sourceVideoId
      error.value = null
      failedAction.value = null
      fieldErrors.value = {}
    }

    function persist(): void {
      if (!cache || !activeKey || !response.value) return
      cache.putSearch(activeKey, {
        response: response.value, sourceVideos: sourceVideos.value, sortMode: sortMode.value,
        pageCount: pageCount.value, totalItemsScanned: totalItemsScanned.value,
        totalQuotaUsedEstimate: totalQuotaUsedEstimate.value, lastAddedCount: lastAddedCount.value,
        paginationStopped: paginationStopped.value, consumedTokens: [...consumedTokens],
        scrollY: scrollY.value, sourceVideoId: sourceVideoId.value,
      })
    }

    function saveContext(position: number, videoId: string | null = sourceVideoId.value): void {
      scrollY.value = Number.isFinite(position) ? Math.max(0, position) : 0
      sourceVideoId.value = videoId
      persist()
      cache?.setDraft(draft)
    }

    if (cache && activeKey) {
      const saved = cache.getSearch(activeKey)
      if (saved) restore(saved)
      else activeKey = null
    }
    if (cache) watch(draft, () => cache.setDraft(draft), { deep: true, flush: 'sync' })

    const busy = computed(() => pending.value !== null)
    const hasDraftChanges = computed(() => {
      if (response.value === null) return false
      const result = validateDraft(draft)
      return !result.valid || criteriaKey(result.request) !== criteriaKey(response.value.applied)
    })
    // Server retryable metadata does not prohibit a later, explicit user retry.
    const canRetry = computed(() => !busy.value && failedAction.value !== null)
    const canLoadMore = computed(() => !busy.value && !paginationStopped.value
      && isPageToken(response.value?.next_page_token)
      && !consumedTokens.has(response.value.next_page_token))

    function setSort(mode: SortMode): void {
      if (sortOptions.some(option => option.value === mode)) {
        sortMode.value = mode
        persist()
      }
    }

    function clearFieldError(field: SearchDraftField): void {
      delete fieldErrors.value[field]
    }

    function patchDraft(patch: Partial<SearchDraft>): void {
      const copy = { ...patch }
      if (copy.durationRanges !== undefined) copy.durationRanges = [...copy.durationRanges]
      Object.assign(draft, copy)
      for (const field of Object.keys(patch) as SearchDraftField[]) clearFieldError(field)
    }

    function resetFilters(): void {
      const defaults = createEmptyDraft()
      patchDraft({
        language: defaults.language,
        minSubscribers: defaults.minSubscribers,
        maxSubscribers: defaults.maxSubscribers,
        period: defaults.period,
        durationRanges: defaults.durationRanges,
      })
    }

    async function runAction(action: SearchAction): Promise<boolean> {
      if (busy.value) return false
      const snapshot = copyAction(action)
      const id = ++requestId
      const activeController = new AbortController()
      controller = activeController
      pending.value = copyAction(snapshot)
      error.value = null
      fieldErrors.value = {}
      failedAction.value = null
      try {
        const result = await apiFactory().searchVideos(copyRequest(snapshot.request), { signal: activeController.signal })
        if (id !== requestId || activeController.signal.aborted) return false
        if (!isSearchResponse(result) || !matchesAction(result, snapshot)) {
          throw new ApiError('Сервис вернул некорректный ответ.', { code: 'invalid_response', retryable: true })
        }
        if (snapshot.kind === 'more') {
          const previousCount = sourceVideos.value.length
          sourceVideos.value = deduplicateVideos([...sourceVideos.value, ...result.videos])
          lastAddedCount.value = sourceVideos.value.length - previousCount
          if (isPageToken(snapshot.request.page_token)) consumedTokens.add(snapshot.request.page_token)
          paginationStopped.value = isPageToken(result.next_page_token) && consumedTokens.has(result.next_page_token)
          response.value = { ...result, applied: response.value!.applied }
          pageCount.value += 1
          totalItemsScanned.value += result.items_scanned
          totalQuotaUsedEstimate.value += result.quota_used_estimate
        } else {
          sourceVideos.value = deduplicateVideos(result.videos)
          lastAddedCount.value = sourceVideos.value.length
          consumedTokens.clear()
          paginationStopped.value = false
          response.value = result
          pageCount.value = 1
          totalItemsScanned.value = result.items_scanned
          totalQuotaUsedEstimate.value = result.quota_used_estimate
          activeKey = searchCacheKey(snapshot.request)
          scrollY.value = 0
          sourceVideoId.value = null
        }
        persist()
        return true
      } catch (caught) {
        if (id !== requestId || activeController.signal.aborted || isAbortError(caught)) return false
        const failure = caught instanceof ApiError
          ? caught
          : new ApiError('Не удалось выполнить поиск. Попробуйте ещё раз.', { code: 'unexpected_error', retryable: true })
        failedAction.value = snapshot
        error.value = failure
        if (snapshot.kind === 'search' && failure.status === 422) {
          const current = validateDraft(draft)
          if (current.valid && criteriaKey(current.request) === criteriaKey(snapshot.request)) {
            fieldErrors.value = validationErrors(failure)
          }
        }
        return false
      } finally {
        if (id === requestId) {
          pending.value = null
          controller = null
        }
      }
    }

    async function search(): Promise<boolean> {
      if (busy.value) return false
      const result = validateDraft(draft)
      fieldErrors.value = result.errors
      if (!result.valid) return false
      const key = searchCacheKey(result.request)
      const saved = cache?.getSearch(key)
      if (saved) {
        activeKey = key
        restore(saved)
        persist()
        return true
      }
      return runAction({ kind: 'search', request: result.request })
    }

    async function refresh(): Promise<boolean> {
      if (busy.value || response.value === null) return false
      return runAction({ kind: 'refresh', request: createRefreshRequest(response.value.applied) })
    }

    async function loadMore(): Promise<boolean> {
      if (!canLoadMore.value || response.value === null || !isPageToken(response.value.next_page_token)) return false
      const request = copyRequest(response.value.applied)
      request.page_token = response.value.next_page_token
      if ((request.period ?? 'all') !== 'all' && !request.published_after) {
        error.value = new ApiError('Для продолжения поиска отсутствует исходная граница периода. Обновите результаты.', {
          code: 'invalid_response', retryable: false,
        })
        failedAction.value = null
        return false
      }
      return runAction({ kind: 'more', request })
    }

    async function retry(): Promise<boolean> {
      if (!canRetry.value || failedAction.value === null) return false
      return runAction(failedAction.value)
    }

    function cancel(): void {
      ++requestId
      controller?.abort()
      controller = null
      pending.value = null
    }

    return {
      draft, response, pending, busy, error, fieldErrors, hasDraftChanges, canRetry,
      sourceVideos, sortedVideos, sortMode, canLoadMore, pageCount, totalItemsScanned,
      totalQuotaUsedEstimate, lastAddedCount, paginationStopped, scrollY, sourceVideoId, persistenceWarning,
      patchDraft, resetFilters, clearFieldError, search, refresh, loadMore, setSort, retry, cancel, saveContext,
    }
  })
}

export const useSearchStore = createSearchStore(createConfiguredApiClient, useSessionCacheStore)
export default useSearchStore

import { defineStore } from 'pinia'
import { computed, reactive, ref, shallowRef } from 'vue'
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

function isSearchResponse(value: unknown): value is SearchVideosResponse {
  if (!isRecord(value) || !isRecord(value.applied)) return false
  const applied = value.applied
  return isRecord(value)
    && typeof value.query === 'string'
    && isRecord(value.applied)
    && (value.applied.query === undefined || typeof value.applied.query === 'string')
    && (value.applied.duration_ranges === undefined || (Array.isArray(value.applied.duration_ranges)
      && value.applied.duration_ranges.every(range => ['up_to_3m', '3_to_10m', '10_to_30m', '30_to_60m', 'over_60m'].includes(range))))
    && (value.applied.period === undefined || ['all', 'day', 'week', 'month', 'year'].includes(value.applied.period as string))
    && (value.applied.limit === undefined || (typeof value.applied.limit === 'number'
      && Number.isInteger(value.applied.limit) && value.applied.limit >= 1 && value.applied.limit <= 50))
    && ['published_after', 'published_before', 'relevance_language'].every(key => applied[key] == null || typeof applied[key] === 'string')
    && ['min_views', 'max_views', 'min_subscribers', 'max_subscribers'].every(key => applied[key] == null
      || (typeof applied[key] === 'number' && Number.isSafeInteger(applied[key]) && applied[key] >= 0))
    && (value.applied.page_token == null || isPageToken(value.applied.page_token))
    && Array.isArray(value.videos)
    && value.videos.every(video => isRecord(video) && typeof video.id === 'string' && typeof video.title === 'string')
    && typeof value.fetched_at === 'string'
    && (value.next_page_token == null || isPageToken(value.next_page_token))
    && [value.items_scanned, value.matched_count, value.quota_used_estimate]
      .every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
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

export function createSearchStore(apiFactory: () => ApiClient = createConfiguredApiClient) {
  return defineStore('search', () => {
    const draft = reactive<SearchDraft>(createEmptyDraft())
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
      if (sortOptions.some(option => option.value === mode)) sortMode.value = mode
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
        if (!isSearchResponse(result)
          || (snapshot.kind === 'more' && (appliedKey(result.applied) !== appliedKey(snapshot.request)
            || result.query !== (snapshot.request.query ?? '')))) {
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
        }
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
      totalQuotaUsedEstimate, lastAddedCount, paginationStopped,
      patchDraft, resetFilters, clearFieldError, search, refresh, loadMore, setSort, retry, cancel,
    }
  })
}

export const useSearchStore = createSearchStore()
export default useSearchStore

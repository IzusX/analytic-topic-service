import { defineStore } from 'pinia'
import { computed, reactive, ref, shallowRef } from 'vue'
import { ApiError, createConfiguredApiClient } from '../api'
import type { ApiClient, SearchVideosRequest, SearchVideosResponse } from '../api'
import { createEmptyDraft, createRefreshRequest, criteriaKey, validateDraft } from '../features/search/model'
import type { SearchDraft, SearchDraftField, SearchErrors } from '../features/search/model'

type SearchAction = { kind: 'search' | 'refresh'; request: SearchVideosRequest }

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
  return isRecord(value)
    && typeof value.query === 'string'
    && isRecord(value.applied)
    && (value.applied.query === undefined || typeof value.applied.query === 'string')
    && (value.applied.duration_ranges === undefined || Array.isArray(value.applied.duration_ranges))
    && Array.isArray(value.videos)
    && value.videos.every(video => isRecord(video) && typeof video.id === 'string' && typeof video.title === 'string')
    && typeof value.fetched_at === 'string'
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
        if (!isSearchResponse(result)) {
          throw new ApiError('Сервис вернул некорректный ответ.', { code: 'invalid_response', retryable: true })
        }
        response.value = result
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
      patchDraft, resetFilters, clearFieldError, search, refresh, retry, cancel,
    }
  })
}

export const useSearchStore = createSearchStore()
export default useSearchStore

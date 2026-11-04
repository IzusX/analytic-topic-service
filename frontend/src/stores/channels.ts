import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { ApiError, createConfiguredApiClient } from '../api'
import type { ApiClient, ChannelCardOut } from '../api'
import { channelCacheKey, isChannelSnapshot, useSessionCacheStore } from './sessionCache'

export interface ChannelLoadOptions { forceSync?: boolean; signal?: AbortSignal }

/** Explicit actions only: creating this store never fetches a channel. */
export function createChannelsStore(
  apiFactory: () => ApiClient = createConfiguredApiClient,
  cacheFactory: () => ReturnType<typeof useSessionCacheStore> = useSessionCacheStore,
) {
  return defineStore('channels', () => {
    const cache = cacheFactory()
    const response = shallowRef<ChannelCardOut | null>(null)
    const channelId = ref<string | null>(null)
    const pending = ref(false)
    const error = shallowRef<ApiError | null>(null)
    const persistenceWarning = computed(() => cache.persistenceWarning)
    let requestId = 0
    let controller: AbortController | null = null
    let inFlight: { key: string; promise: Promise<boolean> } | null = null

    function cancel(): void {
      ++requestId
      controller?.abort()
      controller = null
      inFlight = null
      pending.value = false
    }

    function load(id: string, options: ChannelLoadOptions = {}): Promise<boolean> {
      const key = channelCacheKey(id)
      if (inFlight?.key === key) return inFlight.promise
      cancel()
      const generation = requestId
      channelId.value = id
      error.value = null
      const previous = cache.getChannel(key)
      response.value = previous
      if (options.signal?.aborted) return Promise.resolve(false)
      if (previous && !options.forceSync) return Promise.resolve(true)
      const activeController = new AbortController()
      controller = activeController
      const abort = () => activeController.abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      pending.value = true
      const promise = (async () => {
        try {
          const result = await apiFactory().getChannel(id, {
            ...(options.forceSync === undefined ? {} : { forceSync: options.forceSync }), signal: activeController.signal,
          })
          if (generation !== requestId || activeController.signal.aborted) return false
          if (!isChannelSnapshot(result) || result.channel.id !== id) {
            throw new ApiError('Сервис вернул некорректный ответ.', { code: 'invalid_response', retryable: true })
          }
          cache.putChannel(key, result)
          response.value = cache.getChannel(key)
          return true
        } catch (caught) {
          if (generation !== requestId || activeController.signal.aborted
            || (typeof caught === 'object' && caught !== null && 'name' in caught && caught.name === 'AbortError')) return false
          error.value = caught instanceof ApiError ? caught : new ApiError('Не удалось загрузить анализ канала. Попробуйте ещё раз.', {
            code: 'unexpected_error', retryable: true,
          })
          return false
        } finally {
          options.signal?.removeEventListener('abort', abort)
          if (generation === requestId) {
            pending.value = false
            controller = null
            inFlight = null
          }
        }
      })()
      if (pending.value) inFlight = { key, promise }
      return promise
    }
    return { channelId, response, pending, error, persistenceWarning, load, cancel }
  })
}
export const useChannelsStore = createChannelsStore()

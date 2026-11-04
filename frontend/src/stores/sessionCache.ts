import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChannelCardOut, SearchVideosRequest, SearchVideosResponse, VideoOut } from '../api'
import { criteriaKey } from '../features/search/model'
import type { SearchDraft } from '../features/search/model'
import { sortOptions } from '../features/search/results'
import type { SortMode } from '../features/search/results'

export interface SearchSnapshot {
  response: SearchVideosResponse
  sourceVideos: VideoOut[]
  sortMode: SortMode
  pageCount: number
  totalItemsScanned: number
  totalQuotaUsedEstimate: number
  lastAddedCount: number | null
  paginationStopped: boolean
  consumedTokens: string[]
  scrollY: number
  sourceVideoId: string | null
}

export const SESSION_CACHE_KEY = 'analytic-topic:session:v2'
export const SESSION_CACHE_MAX_BYTES = 3 * 1024 * 1024
export const CHANNEL_SELECTION_KEY = 'service:gt180:limit30:scan200:pages4:v2'
export function channelCacheKey(channelId: string): string {
  return `${CHANNEL_SELECTION_KEY}:${JSON.stringify(channelId)}`
}
export function searchCacheKey(request: SearchVideosRequest): string {
  return JSON.stringify({ namespace: 'service', schema: 2, criteria: criteriaKey(request),
    limit: request.limit ?? 50, minViews: request.min_views ?? null, maxViews: request.max_views ?? null,
    publishedAfter: (request.period ?? 'all') === 'all' ? request.published_after ?? null : null,
    publishedBefore: request.published_before ?? null })
}

type RecordValue = Record<string, unknown>
const record = (v: unknown): v is RecordValue => typeof v === 'object' && v !== null && !Array.isArray(v)
const string = (v: unknown): v is string => typeof v === 'string'
const boolean = (v: unknown): v is boolean => typeof v === 'boolean'
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v)
const token = (v: unknown): v is string => string(v) && v.length > 0 && v.length <= 2048 && !/[\x00-\x20\x7f]/.test(v)
const periods = ['all', 'day', 'week', 'month', 'year']
const ranges = ['up_to_3m', '3_to_10m', '10_to_30m', '30_to_60m', 'over_60m']
type Guard = (v: unknown) => boolean
const oneOf = (values: readonly unknown[]): Guard => v => values.includes(v)
const array = (guard: Guard): Guard => v => Array.isArray(v) && v.every(guard)
const nullable = (guard: Guard): Guard => v => v === null || guard(v)
/** Unknown fields are rejected: only explicitly consumed DTO data reaches storage. */
function shape(v: unknown, required: Record<string, Guard>, optional: Record<string, Guard> = {}): v is RecordValue {
  return record(v) && Object.entries(required).every(([key, guard]) => guard(v[key]))
    && Object.entries(v).every(([key, value]) => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]!(value)))
}
function fields(keys: string, guard: Guard): Record<string, Guard> {
  return Object.fromEntries(keys.split(' ').map(key => [key, guard]))
}
const videoOptional = {
  ...fields('published_at duration thumbnail_url channel_id channel_title', nullable(string)),
  ...fields('duration_seconds view_count like_count comment_count channel_subscriber_count', nullable(integer)),
  ...fields('view_sub_ratio like_view_ratio comment_view_ratio view_median_ratio', nullable(number)),
  channel_subscriber_count_hidden: nullable(boolean),
}
const video: Guard = v => shape(v, { id: string, title: string }, videoOptional)
const request: Guard = v => shape(v, {}, {
  query: string, limit: v => integer(v) && v >= 1 && v <= 50,
  period: oneOf(periods), duration_ranges: array(oneOf(ranges)),
  ...fields('published_after published_before relevance_language', nullable(string)),
  ...fields('min_views max_views min_subscribers max_subscribers', nullable(integer)), page_token: nullable(token),
})
const searchResponse: Guard = v => shape(v, {
  query: string, applied: request, videos: array(video), fetched_at: string,
  items_scanned: integer, matched_count: integer, quota_used_estimate: integer,
}, { next_page_token: nullable(token), order: string })
const draftGuard: Guard = v => shape(v, {
  ...fields('query language minSubscribers maxSubscribers', string), period: oneOf(periods), durationRanges: array(oneOf(ranges)),
})
function snapshotGuard(v: unknown): v is SearchSnapshot {
  return shape(v, {
    response: searchResponse, sourceVideos: array(video), sortMode: oneOf(sortOptions.map(option => option.value)),
    ...fields('pageCount totalItemsScanned totalQuotaUsedEstimate', integer), lastAddedCount: nullable(integer),
    paginationStopped: boolean, consumedTokens: array(token), scrollY: number, sourceVideoId: nullable(string),
  }) && Array.isArray(v.sourceVideos) && new Set(v.sourceVideos.map(item => (item as VideoOut).id)).size === v.sourceVideos.length
}
const sample: Guard = v => shape(v, {
  ...fields('selected_count metric_count uploads_scanned pages_scanned', integer),
  stop_reason: oneOf(['sample_full', 'uploads_exhausted', 'scan_limit']), target_reached: boolean, scan_limit_reached: boolean,
}, {
  ...fields('unavailable_video_count unknown_duration_count excluded_duration_count unknown_date_count', integer),
  ...fields('date_from date_to', nullable(string)),
  rule: v => shape(v, {}, { ...fields('min_duration_seconds max_videos max_uploads_scanned max_pages', integer), min_duration_exclusive: boolean }),
})
export function isChannelSnapshot(v: unknown): v is ChannelCardOut {
  return shape(v, {
    channel: v => shape(v, { id: string, title: string }, {
      ...fields('description published_at country thumbnail_url uploads_playlist_id last_synced_at', nullable(string)),
      ...fields('subscriber_count view_count video_count', nullable(integer)), subscriber_count_hidden: nullable(boolean),
    }),
    sample, metrics: v => shape(v, { count: integer }, {
      ...fields('median_views mean_views std_views cv spike_ratio consistency max_views min_views avg_like_view avg_comment_view', nullable(number)),
      ...fields('like_view_count comment_view_count', integer),
    }), summary: string, videos: array(video), fetched_at: string,
  }, {
    from_cache: boolean, quota_used_estimate: integer,
    source_video: nullable(v => shape(v, { id: string, status: oneOf(['included', 'duration_too_short', 'duration_unknown', 'not_in_sample', 'channel_mismatch']) },
      { reason: nullable(string), view_median_ratio: nullable(number) })),
  })
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
interface Entry<T> { key: string; touched: number; value: T }

/** Factory defaults to isolated memory; only the application singleton opts into browser storage. */
export function createSessionCacheStore(storageFactory?: () => Storage) {
  return defineStore('sessionCache', () => {
    const draft = ref<SearchDraft | null>(null)
    const activeSearchKey = ref<string | null>(null)
    const activeChannelKey = ref<string | null>(null)
    const persistenceWarning = ref<string | null>(null)
    let searches: Entry<SearchSnapshot>[] = []
    let channels: Entry<ChannelCardOut>[] = []
    let clock = 0
    let storage: Storage | undefined
    const warn = () => { persistenceWarning.value = 'Кеш сессии недоступен. Данные сохранены только в памяти и могут быть потеряны после перезагрузки.' }
    const payload = () => ({ version: 2, draft: draft.value, activeSearchKey: activeSearchKey.value,
      activeChannelKey: activeChannelKey.value, searches, channels })
    const serialized = () => JSON.stringify(payload())
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength
    function removeSnapshot(): void {
      try { storage?.removeItem(SESSION_CACHE_KEY) } catch { warn() }
    }
    function oldest<T>(entries: Entry<T>[], active: string | null): Entry<T> | undefined {
      return entries.filter(entry => entry.key !== active).sort((a, b) => a.touched - b.touched)[0]
    }
    function trim(): void {
      while (searches.length > 5) {
        const entry = oldest(searches, activeSearchKey.value)
        if (!entry) break
        searches.splice(searches.indexOf(entry), 1)
      }
      while (channels.length > 10) {
        const entry = oldest(channels, activeChannelKey.value)
        if (!entry) break
        channels.splice(channels.indexOf(entry), 1)
      }
      while (bytes(serialized()) > SESSION_CACHE_MAX_BYTES) {
        const search = oldest(searches, activeSearchKey.value)
        const channel = oldest(channels, activeChannelKey.value)
        if (!search && !channel) break
        if (search && (!channel || search.touched <= channel.touched)) searches.splice(searches.indexOf(search), 1)
        else if (channel) channels.splice(channels.indexOf(channel), 1)
      }
    }
    function save(): void {
      trim()
      const text = serialized()
      if (bytes(text) > SESSION_CACHE_MAX_BYTES) { warn(); removeSnapshot(); return }
      if (!storage) return
      try { storage.setItem(SESSION_CACHE_KEY, text); persistenceWarning.value = null }
      catch { warn(); removeSnapshot() }
    }
    function getSearch(key: string): SearchSnapshot | null {
      const entry = searches.find(entry => entry.key === key)
      if (!entry) return null
      entry.touched = ++clock
      activeSearchKey.value = key
      const value = copy(entry.value)
      save()
      return value
    }
    function putSearch(key: string, value: SearchSnapshot): void {
      if (!snapshotGuard(value)) return
      searches = searches.filter(entry => entry.key !== key)
      searches.push({ key, touched: ++clock, value: copy(value) })
      activeSearchKey.value = key
      save()
    }
    function getChannel(key: string): ChannelCardOut | null {
      const entry = channels.find(entry => entry.key === key)
      if (!entry) return null
      entry.touched = ++clock
      activeChannelKey.value = key
      const value = copy(entry.value)
      save()
      return value
    }
    function putChannel(key: string, value: ChannelCardOut): void {
      if (!isChannelSnapshot(value)) return
      // Source context belongs to navigation, never to the common analysis cache.
      const detached = copy(value)
      delete detached.source_video
      channels = channels.filter(entry => entry.key !== key)
      channels.push({ key, touched: ++clock, value: detached })
      activeChannelKey.value = key
      save()
    }
    function setDraft(value: SearchDraft): void { draft.value = copy(value); save() }
    if (storageFactory) {
      try {
        storage = storageFactory()
        const text = storage.getItem(SESSION_CACHE_KEY)
        if (text !== null) {
          const parsed: unknown = JSON.parse(text)
          const entryGuard = (guard: Guard): Guard => v => shape(v, { key: string, touched: integer, value: guard })
          if (bytes(text) > SESSION_CACHE_MAX_BYTES || !shape(parsed, {
            version: v => v === 2, draft: nullable(draftGuard), activeSearchKey: nullable(string), activeChannelKey: nullable(string),
            searches: array(entryGuard(snapshotGuard)), channels: array(entryGuard(isChannelSnapshot)),
          })) throw new Error('Invalid cache')
          // Shape guards validate every consumed field before the DTO type assertion.
          const valid = parsed as unknown as ReturnType<typeof payload>
          if (new Set(valid.searches.map(entry => entry.key)).size !== valid.searches.length
            || new Set(valid.channels.map(entry => entry.key)).size !== valid.channels.length
            || valid.searches.some(entry => entry.key !== searchCacheKey(entry.value.response.applied))
            || valid.channels.some(entry => entry.key !== channelCacheKey(entry.value.channel.id))
            || (valid.activeSearchKey !== null && !valid.searches.some(entry => entry.key === valid.activeSearchKey))
            || (valid.activeChannelKey !== null && !valid.channels.some(entry => entry.key === valid.activeChannelKey))) throw new Error('Invalid cache identity')
          searches = valid.searches
          channels = valid.channels
          draft.value = valid.draft
          activeSearchKey.value = valid.activeSearchKey
          activeChannelKey.value = valid.activeChannelKey
          clock = Math.max(0, ...searches.map(entry => entry.touched), ...channels.map(entry => entry.touched))
          trim()
        }
      } catch { warn(); removeSnapshot() }
    }
    return { draft, activeSearchKey, activeChannelKey, persistenceWarning, getSearch, putSearch, getChannel, putChannel, setDraft, save }
  })
}
export const useSessionCacheStore = createSessionCacheStore(() => window.sessionStorage)

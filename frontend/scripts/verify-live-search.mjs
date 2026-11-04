import { createServer } from 'vite'
import { createPinia } from 'pinia'
import { mkdir, writeFile } from 'node:fs/promises'

if (process.env.RUN_LIVE_SEARCH !== '1') {
  throw new Error('This opt-in check uses YouTube quota. Set RUN_LIVE_SEARCH=1 explicitly.')
}
const origin = new URL(process.env.API_BASE_URL ?? 'http://127.0.0.1:5173')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('Live integration requires a public local origin without credentials or extra URL parts.')
}
const vite = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom',
})
const report = { startedAt: new Date().toISOString(), origin: origin.origin, checks: [], quotaUsedEstimate: 0 }
const requests = []

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const { createApiClient } = await vite.ssrLoadModule('/src/api/client.ts')
  const { createSearchStore } = await vite.ssrLoadModule('/src/stores/search.ts')
  const client = createApiClient({ baseUrl: origin.origin })
  const api = {
    async searchVideos(request, options) {
      ensure(requests.length < 3, 'Live search budget exceeded.')
      requests.push(JSON.parse(JSON.stringify(request)))
      return client.searchVideos(request, options)
    },
    getChannel() { throw new Error('Channel loading is outside this search check.') },
    getVideo() { throw new Error('Video loading is outside this search check.') },
  }
  const store = createSearchStore(() => api)(createPinia())
  store.patchDraft({ query: 'python tutorial', language: 'en', period: 'month' })
  ensure(requests.length === 0 && store.response === null, 'Store setup/edits must not fetch.')

  ensure(await store.search(), 'Text search did not succeed.')
  ensure(store.response.items_scanned <= 50 && store.response.videos.length === store.response.matched_count, 'Bounded search response mismatch.')
  ensure(store.response.applied.published_after, 'Relative period needs an applied absolute boundary.')
  ensure(!('published_after' in requests[0]), 'New search must let the server compute its boundary.')
  report.quotaUsedEstimate += store.response.quota_used_estimate
  report.checks.push({ check: 'text_search', matched: store.response.matched_count, scanned: store.response.items_scanned, fetchedAt: store.response.fetched_at, quota: store.response.quota_used_estimate })

  const firstApplied = JSON.parse(JSON.stringify(store.response.applied))
  store.patchDraft({ query: 'неприменённый черновик', period: 'week', minSubscribers: '999', durationRanges: ['over_60m'] })
  const draftBeforeRefresh = JSON.stringify(store.draft)
  ensure(requests.length === 1 && store.hasDraftChanges, 'Draft editing must preserve current applied data without fetching.')
  ensure(await store.refresh(), 'Applied refresh did not succeed.')
  ensure(requests[1].query === firstApplied.query && requests[1].period === firstApplied.period, 'Refresh used unsent draft.')
  ensure(!('published_after' in requests[1]) && !('page_token' in requests[1]), 'Refresh must recompute relative period, not continue an old page.')
  ensure(JSON.stringify(store.draft) === draftBeforeRefresh, 'Refresh changed draft.')
  report.quotaUsedEstimate += store.response.quota_used_estimate
  report.checks.push({ check: 'refresh_applied_not_draft', matched: store.response.matched_count, scanned: store.response.items_scanned, fetchedAt: store.response.fetched_at, quota: store.response.quota_used_estimate })

  store.patchDraft({ query: '', language: '', period: 'all', minSubscribers: '1000000000000', maxSubscribers: '', durationRanges: [] })
  ensure(requests.length === 2, 'Changing to an empty topic must not fetch automatically.')
  ensure(await store.search(), 'Empty-topic search did not succeed.')
  ensure(requests[2].query === '' && requests[2].min_subscribers === 1000000000000, 'Optional-topic criteria mismatch.')
  ensure(store.response.matched_count === 0 && store.response.videos.length === 0, 'Deliberate subscriber postfilter should return an empty page.')
  report.quotaUsedEstimate += store.response.quota_used_estimate
  report.checks.push({ check: 'empty_topic_postfilter', matched: store.response.matched_count, scanned: store.response.items_scanned, hasNextPage: Boolean(store.response.next_page_token), quota: store.response.quota_used_estimate })
  ensure(requests.length === 3, 'Unexpected automatic retry or page loading.')
  report.requests = requests
  report.finishedAt = new Date().toISOString()
  const output = new URL('../verification/', import.meta.url)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('stage6-live.json', output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  console.log('Live search integration passed. No browser rendering was verified.')
} catch (error) {
  console.error(JSON.stringify({ check: 'live_search_integration', status: 'failed', code: typeof error?.code === 'string' ? error.code : 'check_failed', httpStatus: typeof error?.status === 'number' ? error.status : null, completedRequests: requests.length }))
  process.exitCode = 1
} finally {
  await vite.close()
}

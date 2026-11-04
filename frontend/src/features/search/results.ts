import type { VideoOut } from '../../api'
import { isKnownCount, knownRatio } from '../../utils/presentation'

export type SortMode = 'original' | 'views' | 'date' | 'ratio'

export const sortOptions = [
  { label: 'Порядок YouTube', value: 'original' },
  { label: 'Просмотры: по убыванию', value: 'views' },
  { label: 'Дата: сначала новые', value: 'date' },
  { label: 'Просмотры / подписчики: по убыванию', value: 'ratio' },
] satisfies Array<{ label: string; value: SortMode }>

/** Keep the first complete DTO for each ID, never a mixture of page snapshots. */
export function deduplicateVideos(videos: readonly VideoOut[]): VideoOut[] {
  const seen = new Set<string>()
  return videos.filter(video => {
    if (seen.has(video.id)) return false
    seen.add(video.id)
    return true
  })
}

export function sortVideos(videos: readonly VideoOut[], mode: SortMode): VideoOut[] {
  if (mode === 'original') return [...videos]
  function metric(video: VideoOut): number | null {
    if (mode === 'views') return isKnownCount(video.view_count) ? video.view_count : null
    if (mode === 'ratio') return knownRatio(video)
    const date = video.published_at ? Date.parse(video.published_at) : NaN
    return Number.isFinite(date) ? date : null
  }
  return videos.map((video, index) => ({ video, index, value: metric(video) }))
    .sort((first, second) => {
      if (first.value === null) return second.value === null ? first.index - second.index : 1
      if (second.value === null) return -1
      return second.value - first.value || first.index - second.index
    }).map(({ video }) => video)
}

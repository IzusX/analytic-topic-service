import type { SearchVideosRequest } from '../../api'
import { formatExactCount } from '../../utils/presentation'
import { durationOptions, languageOptions, periodOptions } from './options'

export function describeCriteria(applied: SearchVideosRequest): string {
  const topic = applied.query?.trim() ? `«${applied.query.trim()}»` : 'Без темы'
  const language = languageOptions.find(option => option.value === (applied.relevance_language ?? ''))?.label ?? 'Язык не указан'
  const period = periodOptions.find(option => option.value === (applied.period ?? 'all'))?.label ?? 'Период не указан'
  const bounds = applied.min_subscribers == null && applied.max_subscribers == null
    ? 'любое число подписчиков'
    : `подписчики ${applied.min_subscribers == null ? 'без минимума' : 'от ' + formatExactCount(applied.min_subscribers)} ${applied.max_subscribers == null ? 'без максимума' : 'до ' + formatExactCount(applied.max_subscribers)}`
  const ranges = applied.duration_ranges ?? []
  const duration = ranges.length > 0
    ? durationOptions.filter(option => ranges.includes(option.value)).map(option => option.label).join(', ')
    : 'любая длительность'
  return `${topic}; ${language}; ${bounds}; ${period}; ${duration}.`
}

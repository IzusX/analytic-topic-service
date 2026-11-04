import type { VideoOut } from '../api'

export const noData = 'Нет данных'

export function isKnownCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function formatExactCount(value: number | null | undefined): string {
  return isKnownCount(value) ? new Intl.NumberFormat('ru-RU').format(value) : noData
}

export function formatCompactCount(value: number | null | undefined): string {
  return isKnownCount(value)
    ? new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : noData
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!isKnownCount(seconds)) return noData
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = String(seconds % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`
}

export function formatUtcDate(value: string | null | undefined, withTime = false): string {
  if (!value) return noData
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return noData
  const options: Intl.DateTimeFormatOptions = {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }
  return new Intl.DateTimeFormat('ru-RU', options).format(date) + (withTime ? ' UTC' : '')
}

export function knownRatio(video: Pick<VideoOut, 'view_sub_ratio' | 'channel_subscriber_count' | 'channel_subscriber_count_hidden'>): number | null {
  if (video.channel_subscriber_count_hidden === true || !isKnownCount(video.channel_subscriber_count) || video.channel_subscriber_count === 0) return null
  const value = video.view_sub_ratio
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function formatRatio(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  const rounded = Math.round(value * 10) / 10
  const approximate = Math.abs(rounded - value) > Number.EPSILON * Math.max(1, value)
  return `${approximate ? '≈' : ''}${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)}×`
}

export function ratioLevel(value: number | null): 'unknown' | 'low' | 'mild' | 'medium' | 'high' {
  if (value === null || !Number.isFinite(value) || value < 0) return 'unknown'
  return value < 1 ? 'low' : value < 3 ? 'mild' : value < 10 ? 'medium' : 'high'
}

export function isResourceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export function thumbnailUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

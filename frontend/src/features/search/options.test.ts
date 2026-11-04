/// <reference types="node" />
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { durationOptions, languageCodes, languageOptions, periodOptions } from './options'

it('keeps language choices in parity with the existing backend allowlist', () => {
  const source = readFileSync(new URL('../../../../backend/app/schemas/common.py', import.meta.url), 'utf8')
  const block = source.match(/SUPPORTED_RELEVANCE_LANGUAGES\s*=\s*frozenset\(\(([\s\S]*?)\)\.split\(\)\)/)?.[1]
  expect(block).toBeDefined()
  const backendCodes = [...(block ?? '').matchAll(/"([^"]*)"/g)]
    .map(match => match[1] ?? '').join(' ').trim().split(/\s+/)
  expect([...languageCodes].sort()).toEqual([...backendCodes].sort())
})

describe('search options', () => {
  it('offers Any language without turning region into a language filter', () => {
    expect(languageOptions[0]).toEqual({ label: 'Любой язык', value: '' })
    expect(languageCodes).toContain('ru')
    expect(languageCodes).toContain('en')
    expect(languageCodes).toContain('zh-Hans')
    expect(languageCodes).toContain('zh-Hant')
    expect(languageCodes).not.toContain('zh')
    expect(new Set(languageCodes).size).toBe(languageCodes.length)
  })

  it('retains the five agreed publication periods and duration ranges', () => {
    expect(periodOptions.map(option => option.value)).toEqual(['all', 'day', 'week', 'month', 'year'])
    expect(durationOptions.map(option => option.value)).toEqual([
      'up_to_3m', '3_to_10m', '10_to_30m', '30_to_60m', 'over_60m',
    ])
  })
})

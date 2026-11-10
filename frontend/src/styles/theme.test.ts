import { describe, expect, it } from 'vitest'
import { analyticalColors, fontFamily, naiveTheme, palette, themeVariables } from './theme'

function luminance(hex: string) {
  const components = [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
  const linear = components.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05)
}

describe('shared theme', () => {
  it('uses the same semantic values for CSS and Naive UI', () => {
    expect(themeVariables['--app-page']).toBe(palette.page)
    expect(themeVariables['--app-accent']).toBe(palette.accent)
    expect(naiveTheme.common?.bodyColor).toBe(palette.page)
    expect(naiveTheme.common?.primaryColor).toBe(palette.accent)
    expect(naiveTheme.common?.fontFamily).toBe(fontFamily)
    expect(naiveTheme.Button?.heightMedium).toBe('44px')
  })

  it('keeps analytical colors independent from the purple interface accent', () => {
    expect(analyticalColors.high.background).toBe('#75cef2')
    expect(analyticalColors.high.background).not.toBe(palette.accent)
    expect(analyticalColors.median).toBe('#e4c78c')
  })

  it('keeps body, secondary and control text contrast at least 4.5:1', () => {
    for (const surface of [palette.page, palette.surface, palette.header, palette.headerActive]) {
      expect(contrast(palette.text, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.muted, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.accent, surface)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(palette.accentInk, palette.accent)).toBeGreaterThanOrEqual(4.5)
  })

  it('retains readable numerical colors for the planned data roles', () => {
    for (const role of [analyticalColors.low, analyticalColors.mild, analyticalColors.medium, analyticalColors.high, analyticalColors.unknown]) {
      expect(contrast(role.text, role.background)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

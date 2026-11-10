import type { GlobalThemeOverrides } from 'naive-ui'

export const palette = {
  page: '#17181c',
  surface: '#202126',
  header: '#282137',
  headerBorder: '#514364',
  headerActive: '#403255',
  raised: '#292b32',
  border: '#444750',
  divider: '#34363e',
  text: '#f1f2f5',
  muted: '#b5b8c4',
  accent: '#b5a0ff',
  accentHover: '#c6b6ff',
  accentPressed: '#a68bea',
  accentInk: '#21183b',
  focus: '#d5c9ff',
  selection: '#665299',
  data: '#75cef2',
  median: '#e4c78c',
  warning: '#f0cc86',
  error: '#ffb4b8',
} as const

export const fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif'

export const themeVariables = {
  '--app-page': palette.page,
  '--app-surface': palette.surface,
  '--app-header': palette.header,
  '--app-header-border': palette.headerBorder,
  '--app-header-active': palette.headerActive,
  '--app-raised': palette.raised,
  '--app-border': palette.border,
  '--app-divider': palette.divider,
  '--app-text': palette.text,
  '--app-muted': palette.muted,
  '--app-accent': palette.accent,
  '--app-accent-hover': palette.accentHover,
  '--app-focus': palette.focus,
  '--app-selection': palette.selection,
  '--app-font-family': fontFamily,
  '--app-radius-control': '8px',
  '--app-radius-surface': '12px',
} as const

// Data roles stay independent from the interface accent; no chart is built in stage 5.
export const analyticalColors = {
  low: { background: '#253139', text: '#b6d5e3' },
  mild: { background: '#294858', text: '#c9e8f6' },
  medium: { background: '#33718c', text: '#ffffff' },
  high: { background: palette.data, text: '#102b36' },
  unknown: { background: '#33353e', text: '#d0d2da' },
  median: palette.median,
} as const

export const naiveTheme: GlobalThemeOverrides = {
  common: {
    fontFamily,
    fontSize: '16px',
    borderRadius: '8px',
    bodyColor: palette.page,
    cardColor: palette.surface,
    modalColor: palette.surface,
    popoverColor: palette.raised,
    inputColor: palette.page,
    borderColor: palette.border,
    dividerColor: palette.divider,
    textColorBase: palette.text,
    textColor1: palette.text,
    textColor2: palette.muted,
    textColor3: palette.muted,
    placeholderColor: palette.muted,
    primaryColor: palette.accent,
    primaryColorHover: palette.accentHover,
    primaryColorPressed: palette.accentPressed,
    primaryColorSuppl: palette.accentPressed,
  },
  Input: {
    heightMedium: '44px',
    fontSizeMedium: '16px',
    borderRadius: '8px',
  },
  InternalSelection: {
    heightMedium: '44px',
    fontSizeMedium: '16px',
    borderRadius: '8px',
  },
  Button: {
    heightMedium: '44px',
    borderRadiusMedium: '8px',
    textColorPrimary: palette.accentInk,
    textColorHoverPrimary: palette.accentInk,
    textColorPressedPrimary: palette.accentInk,
    textColorFocusPrimary: palette.accentInk,
  },
}

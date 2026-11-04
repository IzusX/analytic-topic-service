import type { SearchVideosRequest } from '../../api'

export type SearchPeriod = NonNullable<SearchVideosRequest['period']>
export type DurationRange = NonNullable<SearchVideosRequest['duration_ranges']>[number]

export const periodOptions = [
  { label: 'Всё время', value: 'all' },
  { label: 'За сутки', value: 'day' },
  { label: 'За неделю', value: 'week' },
  { label: 'За месяц', value: 'month' },
  { label: 'За год', value: 'year' },
] satisfies Array<{ label: string; value: SearchPeriod }>

export const durationOptions = [
  { label: 'До 3 мин', value: 'up_to_3m' },
  { label: '3–10 мин', value: '3_to_10m' },
  { label: '10–30 мин', value: '10_to_30m' },
  { label: '30–60 мин', value: '30_to_60m' },
  { label: 'Более часа', value: 'over_60m' },
] satisfies Array<{ label: string; value: DurationRange }>

// Kept in parity with backend/app/schemas/common.py by options.test.ts.
export const languageCodes = (
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
  'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ' +
  'ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo ' +
  'lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi ' +
  'pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti ' +
  'tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zu zh-Hans zh-Hant'
).split(' ')

export const allowedLanguages = new Set(languageCodes)

function languageLabel(code: string): string {
  let label = code
  try {
    label = new Intl.DisplayNames(['ru'], { type: 'language' }).of(code) ?? code
  } catch {
    // A missing display-name entry does not change the accepted API code.
  }
  return label.charAt(0).toLocaleUpperCase('ru') + label.slice(1)
}

export const languageOptions = [
  { label: 'Любой язык', value: '' },
  ...languageCodes.map(value => ({ label: languageLabel(value), value }))
    .sort((first, second) => first.label.localeCompare(second.label, 'ru')),
]

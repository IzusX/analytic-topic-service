<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import type { InputInst, SelectInst } from 'naive-ui'
import type { SearchDraft, SearchDraftField, SearchErrors } from './model'
import { durationOptions, languageOptions, periodOptions } from './options'
import type { DurationRange, SearchPeriod } from './options'
import SearchIcon from './SearchIcon.vue'

const props = defineProps<{ draft: SearchDraft; errors: SearchErrors; busy: boolean }>()
const emit = defineEmits<{ change: [patch: Partial<SearchDraft>]; submit: []; reset: [] }>()
const queryInput = ref<InputInst | null>(null)
const languageInput = ref<SelectInst | null>(null)
const languageOpen = ref(false)
const minInput = ref<InputInst | null>(null)
const maxInput = ref<InputInst | null>(null)
const filtersOpen = ref(false)
const durationDetails = ref<HTMLDetailsElement | null>(null)
const composing = ref(false)
const selectedFilterCount = computed(() => Number(props.draft.language !== '')
  + Number(props.draft.minSubscribers !== '' || props.draft.maxSubscribers !== '')
  + Number(props.draft.period !== 'all') + Number(props.draft.durationRanges.length > 0))

function submit() {
  if (!props.busy) emit('submit')
}
function queryKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  event.preventDefault()
  if (!event.isComposing && !composing.value && event.keyCode !== 229) submit()
}
function setLanguage(value: string | number | Array<string | number> | null) {
  emit('change', { language: typeof value === 'string' ? value : '' })
}
function setPeriod(event: Event) {
  emit('change', { period: (event.target as HTMLSelectElement).value as SearchPeriod })
}
function toggleDuration(value: DurationRange, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const ranges = checked ? [...props.draft.durationRanges, value] : props.draft.durationRanges.filter(range => range !== value)
  emit('change', { durationRanges: durationOptions.filter(option => ranges.includes(option.value)).map(option => option.value) })
}
async function focusFirstError() {
  const order: SearchDraftField[] = ['query', 'language', 'minSubscribers', 'maxSubscribers', 'period', 'durationRanges']
  const first = order.find(field => props.errors[field] !== undefined)
  if (!first) return
  if (first !== 'query') filtersOpen.value = true
  await nextTick()
  if (first === 'query') queryInput.value?.focus()
  else if (first === 'language') languageInput.value?.focusInput()
  else if (first === 'minSubscribers') minInput.value?.focus()
  else if (first === 'maxSubscribers') maxInput.value?.focus()
  else if (first === 'period') document.getElementById('search-period')?.focus()
  else {
    if (durationDetails.value) durationDetails.value.open = true
    durationDetails.value?.querySelector('summary')?.focus()
  }
}
defineExpose({ focusFirstError })
</script>

<template>
  <form class="search-form" aria-label="Условия поиска" novalidate @submit.prevent>
    <div class="query-row">
      <div class="query-field">
        <label for="search-query">Тема видео <span class="optional">(необязательно)</span></label>
        <NInput ref="queryInput" :value="draft.query" placeholder="Например, ремонт автомобиля" :input-props="{ id: 'search-query', 'aria-describedby': errors.query ? 'query-hint query-error' : 'query-hint', 'aria-invalid': errors.query ? true : undefined, autocomplete: 'off' }" @update:value="value => emit('change', { query: value })" @keydown="queryKeydown" @compositionstart="composing = true" @compositionend="composing = false" />
        <p v-if="errors.query" id="query-error" class="field-error" role="alert">{{ errors.query }}</p>
      </div>
      <NButton class="main-search" attr-type="button" type="primary" :loading="busy" :disabled="busy" @click="submit"><template #icon><SearchIcon name="search" /></template>Искать</NButton>
    </div>
    <p id="query-hint" class="form-hint">Тему можно не указывать — поиск выполнится по выбранным условиям.</p>
    <NButton class="filters-trigger" attr-type="button" :aria-expanded="filtersOpen" aria-controls="search-filters" @click="filtersOpen = !filtersOpen"><template #icon><SearchIcon name="filters" /></template>Фильтры · выбрано {{ selectedFilterCount }}</NButton>
    <div id="search-filters" class="filters-area" :class="{ 'is-open': filtersOpen }">
      <div class="filters-grid">
        <div class="filter-field">
          <label id="language-label" for="search-language">Предпочтительный язык</label>
          <NSelect ref="languageInput" :value="draft.language" :options="languageOptions" filterable clearable placeholder="Любой язык" :input-props="{ id: 'search-language', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': languageOpen, 'aria-label': 'Предпочтительный язык', 'aria-describedby': errors.language ? 'language-hint language-error' : 'language-hint', 'aria-invalid': errors.language ? true : undefined }" @update:show="value => languageOpen = value" @update:value="setLanguage" />
          <p v-if="errors.language" id="language-error" class="field-error" role="alert">{{ errors.language }}</p>
        </div>
        <fieldset class="filter-field subscriber-field">
          <legend>Подписчики канала</legend>
          <div class="subscriber-range">
            <NInput ref="minInput" :value="draft.minSubscribers" placeholder="От" :input-props="{ id: 'search-subs-min', inputmode: 'numeric', 'aria-label': 'Подписчики от', 'aria-describedby': errors.minSubscribers ? 'subs-min-error' : undefined, 'aria-invalid': errors.minSubscribers ? true : undefined }" @update:value="value => emit('change', { minSubscribers: value })" />
            <NInput ref="maxInput" :value="draft.maxSubscribers" placeholder="До" :input-props="{ id: 'search-subs-max', inputmode: 'numeric', 'aria-label': 'Подписчики до', 'aria-describedby': errors.maxSubscribers ? 'subs-max-error' : undefined, 'aria-invalid': errors.maxSubscribers ? true : undefined }" @update:value="value => emit('change', { maxSubscribers: value })" />
          </div>
          <p v-if="errors.minSubscribers" id="subs-min-error" class="field-error" role="alert">{{ errors.minSubscribers }}</p>
          <p v-if="errors.maxSubscribers" id="subs-max-error" class="field-error" role="alert">{{ errors.maxSubscribers }}</p>
        </fieldset>
        <div class="filter-field">
          <label for="search-period">Период публикации</label>
          <select id="search-period" class="native-select" :value="draft.period" :aria-invalid="errors.period ? true : undefined" :aria-describedby="errors.period ? 'period-error' : undefined" @change="setPeriod"><option v-for="option in periodOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select>
          <p v-if="errors.period" id="period-error" class="field-error" role="alert">{{ errors.period }}</p>
        </div>
        <div class="filter-field">
          <span id="duration-label">Длительность видео</span>
          <details ref="durationDetails" class="duration-disclosure">
            <summary :aria-describedby="errors.durationRanges ? 'duration-hint duration-error' : 'duration-hint'" :aria-invalid="errors.durationRanges ? true : undefined"><span class="sr-only">Длительность видео: </span>{{ draft.durationRanges.length ? `Выбрано: ${draft.durationRanges.length}` : 'Любая длительность' }}</summary>
            <div class="duration-options" role="group" aria-labelledby="duration-label">
              <label v-for="option in durationOptions" :key="option.value"><input type="checkbox" :value="option.value" :checked="draft.durationRanges.includes(option.value)" @change="toggleDuration(option.value, $event)" />{{ option.label }}</label>
              <p id="duration-hint" class="form-hint">Верхняя граница включена: 3:00 — первая группа, 3:01 — вторая. Несколько групп объединяются.</p>
            </div>
          </details>
          <p v-if="errors.durationRanges" id="duration-error" class="field-error" role="alert">{{ errors.durationRanges }}</p>
        </div>
      </div>
      <div class="filter-footer">
        <NButton attr-type="button" text @click="emit('reset')">Сбросить фильтры</NButton>
        <p id="language-hint" class="form-hint">Язык — предпочтение YouTube, не строгий фильтр. Запрос не переводится.</p>
        <NButton class="mobile-search" attr-type="button" type="primary" :loading="busy" :disabled="busy" @click="submit"><template #icon><SearchIcon name="search" /></template>Искать</NButton>
      </div>
    </div>
  </form>
</template>

<style scoped>
.search-form { margin-top: 16px; padding: 16px; border: 1px solid var(--app-divider); border-radius: var(--app-radius-surface); background: var(--app-surface); }
.query-row { display: flex; align-items: flex-end; gap: 12px; }
.query-field { flex: 1; min-width: 0; }
.query-field > label { display: block; margin-bottom: 8px; }
.optional { color: var(--app-muted); font-size: 14px; }
.form-hint { margin: 8px 0 0; color: var(--app-muted); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.filters-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.1fr) minmax(0,1fr) minmax(0,1.15fr); align-items: start; gap: 16px; margin-top: 16px; }
.filter-field { min-width: 0; }
.filter-field > label, .filter-field > span, legend { display: block; margin-bottom: 8px; font-size: 14px; }
.subscriber-field { margin: 0; padding: 0; border: 0; }
.subscriber-range { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 8px; }
.native-select, .duration-disclosure > summary { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--app-border); border-radius: var(--app-radius-control); background: var(--app-page); color: var(--app-text); font: inherit; cursor: pointer; }
.duration-disclosure > summary { display: list-item; }
.duration-options { margin-top: 8px; padding: 8px 12px 12px; border: 1px solid var(--app-divider); border-radius: var(--app-radius-control); background: var(--app-page); }
.duration-options label { display: flex; min-height: 44px; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.duration-options input { flex-shrink: 0; width: 18px; height: 18px; accent-color: var(--app-accent); }
.filter-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 8px; }
.filter-footer .form-hint { flex: 1; min-width: 0; margin: 0; }
.filter-footer > .n-button { min-height: 44px; }
.field-error { margin: 6px 0 0; color: #ffb4b8; font-size: 13px; }
.filters-trigger, .mobile-search { display: none; }
@media (min-width: 640px) {
  .duration-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); column-gap: 8px; }
  .duration-options .form-hint { grid-column: 1 / -1; }
}
@media (max-width: 1099px) { .filters-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media (max-width: 639px) {
  .search-form { padding: 16px; }
  .query-row { align-items: stretch; flex-direction: column; }
  .main-search { width: 100%; }
  .filters-trigger { display: flex; width: 100%; margin-top: 16px; }
  .filters-area { display: none; }
  .filters-area.is-open { display: block; }
  .filters-grid { grid-template-columns: minmax(0,1fr); gap: 16px; margin-top: 16px; }
  .filter-footer { align-items: stretch; flex-direction: column; }
  .mobile-search { display: flex; width: 100%; }
}
</style>

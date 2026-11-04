<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { init, use } from 'echarts/core'
import type { EChartsType } from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { VideoOut } from '../../api'
import { chartOption } from './analytics'

use([BarChart, GridComponent, TooltipComponent, MarkLineComponent, SVGRenderer])

const props = defineProps<{
  videos: VideoOut[]
  median?: number | null | undefined
  sourceVideoId?: string | undefined
}>()
const host = ref<HTMLDivElement | null>(null)
const captionId = useId()
let chart: EChartsType | undefined
let observer: ResizeObserver | undefined
let motion: MediaQueryList | undefined

function update(): void {
  chart?.setOption(chartOption(props.videos, props.median, props.sourceVideoId, motion?.matches ?? false), { notMerge: true })
}
function resize(): void { chart?.resize() }

onMounted(() => {
  if (!host.value) return
  motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  motion?.addEventListener('change', update)
  chart = init(host.value, undefined, { renderer: 'svg' })
  update()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(resize)
    observer.observe(host.value)
  } else {
    window.addEventListener('resize', resize)
  }
})
watch(() => [props.videos, props.median, props.sourceVideoId], update, { deep: true })
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', resize)
  motion?.removeEventListener('change', update)
  chart?.dispose()
  chart = undefined
})
</script>

<template>
  <figure class="channel-chart" :aria-labelledby="captionId">
    <div ref="host" class="channel-chart__plot" aria-hidden="true" />
    <figcaption :id="captionId">
      Просмотры видео выборки по дате публикации, от старых к новым. Золотая линия — медиана,
      если она известна. Неизвестные просмотры оставлены пропусками.
      Точные значения, даты и длительность доступны в таблице «Исходные данные» ниже.
    </figcaption>
  </figure>
</template>

<style scoped>
.channel-chart {
  min-width: 0;
  margin: 0;
}
.channel-chart__plot {
  width: 100%;
  height: 340px;
}
figcaption {
  max-width: 75ch;
  color: var(--app-muted);
  font-size: 14px;
  line-height: 1.5;
}
@media (max-width: 639px) {
  .channel-chart__plot { height: 300px; }
}
</style>

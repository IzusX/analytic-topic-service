// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { init, use } from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { chartOption } from './analytics'

use([BarChart, GridComponent, MarkLineComponent, TooltipComponent, SVGRenderer])

describe('actual ECharts SVG compatibility', () => {
  it('labels an included source even when its views are unknown, without a fabricated bar', () => {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 320, height: 300 })
    try {
      chart.setOption(chartOption([{ id: 'source', title: 'Unknown', view_count: null }], null, 'source', true))
      expect(chart.renderToSVGString()).toContain('Видео из поиска')
    } finally { chart.dispose() }
  })
  it.each([320, 1440])('renders safe descriptive options at width %s without a browser or network', width => {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width, height: 300 })
    try {
      chart.setOption(chartOption([
        { id: 'zero', title: '<script>alert(1)</script>', view_count: 0, published_at: '2026-01-01' },
        { id: 'known', title: 'Video', view_count: 100, published_at: '2026-02-01' },
        { id: 'missing', title: 'Unknown', view_count: null },
      ], 50, 'known', true))
      const svg = chart.renderToSVGString()
      expect(svg).toContain('<svg')
      expect(svg).toContain('Медиана: 50')
      expect(svg).toContain('Видео из поиска')
      expect(svg).not.toContain('<script>')
      expect(svg).not.toContain('NaN')
    } finally { chart.dispose() }
  })
})

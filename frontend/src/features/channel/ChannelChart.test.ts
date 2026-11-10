import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChannelChart from './ChannelChart.vue'

const mocks = vi.hoisted(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), init: vi.fn(), use: vi.fn() }))
vi.mock('echarts/core', () => ({ use: mocks.use, init: mocks.init }))
vi.mock('echarts/charts', () => ({ BarChart: 'BarChart' }))
vi.mock('echarts/components', () => ({ GridComponent: 'GridComponent', TooltipComponent: 'TooltipComponent', MarkLineComponent: 'MarkLineComponent' }))
vi.mock('echarts/renderers', () => ({ SVGRenderer: 'SVGRenderer' }))

let wrapper: VueWrapper | undefined
let observedResize: ResizeObserverCallback
let motionChange: () => void
const observe = vi.fn()
const disconnect = vi.fn()
const removeMotion = vi.fn()
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.init.mockReturnValue({ setOption: mocks.setOption, resize: mocks.resize, dispose: mocks.dispose })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observedResize = callback }
    observe = observe
    disconnect = disconnect
  })
  media = { matches: true, addEventListener: vi.fn((_event, callback) => { motionChange = callback }), removeEventListener: removeMotion }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

describe('ChannelChart', () => {
  it('initializes an SVG chart, respects motion preference and provides a table caption', () => {
    wrapper = mount(ChannelChart, { props: { videos: [{ id: 'v', title: 'Видео', view_count: 0 }], median: 0 } })
    expect(mocks.use).toHaveBeenCalledWith(['BarChart', 'GridComponent', 'TooltipComponent', 'MarkLineComponent', 'SVGRenderer'])
    expect(mocks.init).toHaveBeenCalledWith(wrapper.get('.channel-chart__plot').element, undefined, { renderer: 'svg' })
    expect(mocks.setOption).toHaveBeenCalledWith(expect.objectContaining({ animation: false }), { notMerge: true })
    expect(observe).toHaveBeenCalledWith(wrapper.get('.channel-chart__plot').element)
    expect(wrapper.get('.channel-chart__plot').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('figure').attributes('aria-labelledby')).toBe(wrapper.get('figcaption').attributes('id'))
    expect(wrapper.get('figcaption').text()).toContain('Исходные данные')
    expect(wrapper.findAll('a,button')).toHaveLength(0)
  })

  it('updates props and media preference, resizes, then removes resources and disposes', async () => {
    wrapper = mount(ChannelChart, { props: { videos: [] } })
    await wrapper.setProps({ videos: [{ id: 'new', title: 'Новое', view_count: 15 }], median: 7, sourceVideoId: 'new' })
    expect(mocks.setOption.mock.lastCall?.[0]).toMatchObject({ series: [{ data: [{ value: 15, label: { formatter: 'Видео из поиска' } }], markLine: { data: [{ yAxis: 7 }] } }] })
    media.matches = false
    motionChange()
    expect(mocks.setOption.mock.lastCall?.[0].animation).toBe(true)
    observedResize([], {} as ResizeObserver)
    expect(mocks.resize).toHaveBeenCalledOnce()
    wrapper.unmount()
    wrapper = undefined
    expect(disconnect).toHaveBeenCalledOnce()
    expect(removeMotion).toHaveBeenCalledWith('change', motionChange)
    expect(mocks.dispose).toHaveBeenCalledOnce()
    const count = mocks.setOption.mock.calls.length
    motionChange()
    await nextTick()
    expect(mocks.setOption).toHaveBeenCalledTimes(count)
  })

  it.each(['init', 'setOption'] as const)('keeps a readable fallback when chart %s throws', async failure => {
    mocks[failure].mockImplementationOnce(() => { throw new Error('renderer unavailable') })
    wrapper = mount(ChannelChart, { props: { videos: [{ id: 'v', title: 'Video' }] } })
    await nextTick()
    expect(wrapper.get('[role="status"]').text()).toContain('Точные значения сохранены')
    expect(wrapper.get('.channel-chart__plot').isVisible()).toBe(false)
    if (failure === 'setOption') expect(mocks.dispose).toHaveBeenCalledOnce()
  })

  it('supports environments without ResizeObserver or matchMedia and cleans window fallback', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('matchMedia', undefined)
    wrapper = mount(ChannelChart, { props: { videos: [] } })
    window.dispatchEvent(new Event('resize'))
    expect(mocks.resize).toHaveBeenCalledOnce()
    wrapper.unmount()
    wrapper = undefined
    window.dispatchEvent(new Event('resize'))
    expect(mocks.resize).toHaveBeenCalledOnce()
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })
})

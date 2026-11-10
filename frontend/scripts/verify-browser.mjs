import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Run against the already-running Vite app. No backend or YouTube credentials are used.
const root = new URL('../', import.meta.url)
const output = new URL('verification/', root)
const url = new URL(process.env.FRONTEND_URL ?? 'http://127.0.0.1:5173')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
  throw new Error('Browser verification requires a credential-free local frontend URL.')
}
const channelId = 'UC_' + 'a'.repeat(61)
const fetchedAt = '2026-01-20T12:00:00Z'
const longTitle = 'Очень длинное название видео для проверки переноса и полного текста '.repeat(5)
const channelTitle = 'ДлинноеНазваниеКаналаБезПробелов'.repeat(5)
// Bounded DTO fixtures: unknown is null, known zero stays zero; no fake thumbnail URL.
const videos = [0, 1200, null].map((views, index) => ({
  id: `browser_video_${index}`, title: `${index + 1}. ${longTitle}`,
  channel_id: channelId, channel_title: channelTitle,
  published_at: index === 2 ? null : `2026-01-${10 + index}T12:00:00Z`,
  duration_seconds: 240 + index * 60, duration: `PT${4 + index}M`,
  view_count: views, like_count: index === 2 ? null : 0, comment_count: null,
  channel_subscriber_count: index === 2 ? null : index === 0 ? 0 : 100,
  channel_subscriber_count_hidden: index === 2, view_sub_ratio: index === 1 ? 12 : null,
  thumbnail_url: null,
}))
const analysis = {
  channel: { id: channelId, title: channelTitle, subscriber_count: 0, subscriber_count_hidden: false,
    video_count: 3, published_at: null, thumbnail_url: null },
  videos, fetched_at: fetchedAt, from_cache: false, quota_used_estimate: 0,
  sample: { selected_count: 3, metric_count: 2, uploads_scanned: 3, pages_scanned: 1,
    unknown_date_count: 1, date_from: videos[0].published_at, date_to: videos[1].published_at,
    stop_reason: 'uploads_exhausted', target_reached: false, scan_limit_reached: false },
  metrics: { count: 2, median_views: 600, mean_views: 600, std_views: 600, cv: 1,
    spike_ratio: 2, consistency: 0.5, max_views: 1200, min_views: 0,
    avg_like_view: 0, avg_comment_view: null, like_view_count: 1, comment_view_count: 0 },
  source_video: { id: videos[0].id, status: 'included', view_median_ratio: 0 },
  summary: 'Детерминированная выборка: известный ноль, известные просмотры и неизвестные данные.',
}
await mkdir(output, { recursive: true })
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Keep Chromium sandbox protections; parent/operator handles launch permission.
const chrome = spawn(chromePath, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--disable-extensions', '--disable-breakpad', '--remote-debugging-pipe',
  `--user-data-dir=${fileURLToPath(new URL('.browser-profile/', root))}`,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
let startupErrors = ''
chrome.stderr.on('data', data => { startupErrors = (startupErrors + data.toString()).slice(-2000) })
let sequence = 0
let buffer = ''
const pending = new Map()
const observations = new Map()
const results = []
let phase = 'startup'
function progress(label) {
  phase = label
  console.log(`[browser] ${phase}`)
}
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject, label: `${phase}: ${method}${method === 'Runtime.evaluate' ? ' ' + (params.expression ?? '').slice(0, 180) : ''}` })
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
  })
}
function rejectPending(error) {
  for (const waiter of pending.values()) waiter.reject(error)
  pending.clear()
}
chrome.on('error', rejectPending)
chrome.on('exit', (code, signal) => rejectPending(new Error(`Chrome exited (${code ?? signal}). ${startupErrors}`)))
function ensure(condition, message) { if (!condition) throw new Error(message) }

async function intercept(params, sessionId, observed) {
  const requestUrl = new URL(params.request.url)
  const send = (method, args) => call(method, args, sessionId)
  const fail = () => send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' })
  if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== url.origin) {
    observed.blockedExternalRequests.push(requestUrl.origin + requestUrl.pathname)
    await fail()
    return
  }
  if (!requestUrl.pathname.startsWith('/api/')) {
    await send('Fetch.continueRequest', { requestId: params.requestId })
    return
  }
  let dto
  if (requestUrl.pathname === '/api/search/videos' && params.request.method === 'POST') {
    const applied = JSON.parse(params.request.postData ?? '{}')
    ensure(!applied.page_token, 'Unexpected pagination request in bounded search case.')
    dto = { query: applied.query ?? '', applied, videos, fetched_at: fetchedAt,
      next_page_token: null, items_scanned: 3, matched_count: 3, order: 'relevance', quota_used_estimate: 0 }
    observed.searchRequests++
  } else if (requestUrl.pathname === `/api/channels/${channelId}` && params.request.method === 'GET') {
    dto = analysis
    observed.channelRequests++
  } else {
    observed.unexpectedApiRequests.push(params.request.method + ' ' + requestUrl.pathname)
    await fail()
    return
  }
  if (params.networkId) observed.mockNetworkIds.add(params.networkId)
  await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify(dto)).toString('base64') })
  observed.mockedApiRequests++
}
chrome.stdio[4].on('data', data => {
  buffer += data.toString()
  let end
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      message.error ? waiter.reject(new Error(`${waiter.label}: ${message.error.message}`)) : waiter.resolve(message.result)
      continue
    }
    const observed = observations.get(message.sessionId)
    if (!observed) continue
    if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
      console.log(`[browser] ${phase}: main frame ${message.params.frame.url}`)
    }
    if (message.method === 'Inspector.targetCrashed') {
      rejectPending(new Error(`${phase}: Chromium target crashed. ${startupErrors}`))
    }
    if (message.method === 'Fetch.requestPaused') {
      const task = intercept(message.params, message.sessionId, observed)
        .catch(error => { observed.interceptionErrors.push(error.message) })
        .finally(() => observed.interceptions.delete(task))
      observed.interceptions.add(task)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      observed.runtimeErrors.push(details.exception?.description ?? details.text)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      observed.consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '))
    }
    if (message.method === 'Network.requestWillBeSent') {
      if (new URL(message.params.request.url).pathname.startsWith('/api/')) observed.apiNetworkIds.add(message.params.requestId)
    }
    if (message.method === 'Network.responseReceived') {
      const responseUrl = new URL(message.params.response.url)
      if (responseUrl.pathname.startsWith('/api/') && !observed.mockNetworkIds.has(message.params.requestId)) {
        observed.liveApiResponses++
      }
    }
  }
})
const deadline = setTimeout(() => {
  rejectPending(new Error('Browser verification timed out.'))
  chrome.kill()
}, 90000)

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  ensure(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? 'Browser evaluation failed.')
  return result.result.value
}
async function waitFor(send, expression, label) {
  await evaluate(send, `new Promise((resolve,reject)=>{const end=performance.now()+12000;function check(){if(${expression}){resolve(true);return}if(performance.now()>end){reject(new Error(${JSON.stringify(label)}));return}requestAnimationFrame(check)}check()})`)
}
async function frames(send) {
  await evaluate(send, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))')
}
async function key(send, key, code, virtualKey) {
  for (const type of ['keyDown', 'keyUp']) {
    // CDP does not infer text from key/code. Enter needs its character event
    // for native summary activation (and Space for native checkbox activation).
    const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined
    await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtualKey,
      nativeVirtualKeyCode: virtualKey, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) })
  }
  await frames(send)
}
async function activate(send, selector, touch = false) {
  progress(`${phase.split(':')[0]}: ${touch ? 'touch' : 'keyboard'} ${selector}`)
  const target = await evaluate(send, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,focused:document.activeElement===e}})()`)
  ensure(target.focused, `${selector}: cannot receive keyboard focus.`)
  if (touch) {
    ensure(target.height >= 44 && target.width >= 44, `${selector}: touch area below 44px.`)
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] })
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else await key(send, 'Enter', 'Enter', 13)
  await frames(send)
}
async function snapshot(send, name, width) {
  progress(`${width}: snapshot ${name}`)
  await frames(send)
  const check = await evaluate(send, `(()=>{
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
    const exempt=e=>(!e.matches('.table-scroll')&&!!e.closest('.table-scroll'))||(!e.matches('.video-title')&&!!e.closest('.video-title'));
    const overflow=[...document.querySelectorAll('main *')].filter(e=>visible(e)&&!exempt(e)).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left < -1}).map(e=>e.tagName+'.'+e.className).slice(0,12);
    const controls=[...document.querySelectorAll('main button,main a,main summary,main select,main input,nav a')].filter(visible).filter(e=>!e.closest('.table-scroll'));
    const smallTargets=controls.filter(e=>{const area=e.matches('input[type=checkbox]')?e.closest('label'):e.closest('.n-input,.n-base-selection')||e;const r=area.getBoundingClientRect();return r.height<43.5}).map(e=>e.id||e.className||e.tagName);
    return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,heading:document.getElementById('page-title')?.textContent,focus:document.activeElement.id,language:document.documentElement.lang,overflow,smallTargets};
  })()`)
  ensure(check.documentWidth <= width + 1 && check.overflow.length === 0, `${name}: horizontal overflow: ${JSON.stringify(check)}`)
  ensure(check.smallTargets.length === 0 && check.language === 'ru', `${name}: interactive target/language mismatch: ${JSON.stringify(check)}`)
  await evaluate(send, 'window.scrollTo(0,0)')
  const { cssContentSize } = await send('Page.getLayoutMetrics')
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: Math.min(cssContentSize.height, 16000), scale: 1 } })
  await writeFile(new URL(`${name}.png`, output), Buffer.from(data, 'base64'))
  return { name, ...check }
}

try {
  for (const width of [1440, 1100, 390, 320]) {
    progress(`${width}: context and initial navigation`)
    // Separate contexts prevent restored session state from hiding initial/no-auto-load checks.
    const { browserContextId } = await call('Target.createBrowserContext')
    const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
    const observed = { searchRequests: 0, channelRequests: 0, mockedApiRequests: 0, liveApiResponses: 0,
      runtimeErrors: [], consoleErrors: [], interceptionErrors: [], unexpectedApiRequests: [],
      blockedExternalRequests: [], apiNetworkIds: new Set(), mockNetworkIds: new Set(), interceptions: new Set() }
    observations.set(sessionId, observed)
    const send = (method, params) => call(method, params, sessionId)
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Network.enable')
    await send('Network.setCacheDisabled', { cacheDisabled: true })
    await send('Network.setBypassServiceWorker', { bypass: true })
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 640 })
    await send('Emulation.setTouchEmulationEnabled', { enabled: width < 640, maxTouchPoints: 1 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send('Page.navigate', { url: url.href })
    // Page.navigate may resolve while about:blank's execution context still exists.
    // Do not await a page-local polling promise until the new document has committed.
    const navigationEnd = Date.now() + 12000
    while (true) {
      try {
        if (await evaluate(send, `location.origin===${JSON.stringify(url.origin)} && document.readyState!=='loading'`)) break
      } catch (error) {
        if (!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/.test(error.message)) throw error
      }
      ensure(Date.now() < navigationEnd, 'Frontend document did not commit.')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await waitFor(send, "document.getElementById('initial-search-title') && document.activeElement.id==='page-title'", 'Initial search/focus did not mount')
    ensure(observed.searchRequests === 0 && observed.channelRequests === 0, 'Initial search auto-loaded API.')
    results.push(await snapshot(send, `search-initial-${width}`, width))
    await activate(send, '.skip-link')
    ensure(await evaluate(send, "document.activeElement.id==='main-content'"), 'Keyboard skip link failed.')
    if (width < 640) {
      await activate(send, '.filters-trigger')
      ensure(await evaluate(send, "document.querySelector('.filters-trigger').getAttribute('aria-expanded')==='true' && getComputedStyle(document.getElementById('search-filters')).display!=='none'"), 'Keyboard filters expansion failed.')
      await activate(send, '.filters-trigger', true)
      ensure(await evaluate(send, "document.querySelector('.filters-trigger').getAttribute('aria-expanded')==='false'"), 'Touch filter collapse failed.')
      await activate(send, '.filters-trigger', true)
      ensure(await evaluate(send, "document.querySelector('.filters-trigger').getAttribute('aria-expanded')==='true'"), 'Touch filter expansion failed.')
    }
    await activate(send, '.duration-disclosure summary')
    await waitFor(send, "document.querySelector('.duration-disclosure').open", 'Keyboard duration disclosure failed.')
    await evaluate(send, "document.querySelectorAll('.duration-options input')[1].focus()")
    await key(send, ' ', 'Space', 32)
    await waitFor(send, "document.querySelectorAll('.duration-options input')[1].checked", 'Keyboard duration checkbox failed.')
    ensure(observed.searchRequests === 0, 'Filter changes unexpectedly called API.')
    results.push(await snapshot(send, `search-filters-${width}`, width))
    progress(`${width}: query input and Enter search`)
    await evaluate(send, "document.getElementById('search-query').focus()")
    await send('Input.insertText', { text: 'детерминированный поиск' })
    await key(send, 'Enter', 'Enter', 13)
    await waitFor(send, "document.querySelectorAll('.video-card').length===3 && document.querySelector('.results').getAttribute('aria-busy')==='false'", 'Search fixture did not render')
    ensure(observed.searchRequests === 1, 'Search must issue exactly one mocked request.')
    ensure(await evaluate(send, "document.querySelectorAll('.thumbnail-fallback').length===3 && document.querySelectorAll('.video-card img').length===0 && document.querySelectorAll('.ratio-number')[0].textContent==='—' && document.querySelectorAll('.video-metadata')[0].textContent.includes('0') && document.querySelectorAll('.video-metadata')[2].textContent.includes('Нет данных')"), 'Null/zero/absent-thumbnail fixture semantics missing.')
    await activate(send, '.video-details summary')
    ensure(await evaluate(send, `document.querySelector('.video-details').open && document.querySelector('.full-title').textContent===${JSON.stringify(videos[0].title)}`), 'Full video details failed.')
    results.push(await snapshot(send, `search-populated-${width}`, width))
    await activate(send, `#analysis-${videos[0].id}`)
    await waitFor(send, "document.querySelector('.channel-chart__plot svg path') && document.querySelectorAll('.sample-video-list li').length===3 && document.activeElement.id==='page-title'", 'Real ECharts SVG/channel/focus did not render')
    ensure(observed.channelRequests === 1, 'Channel must issue exactly one mocked request.')
    await activate(send, '.analysis-details summary')
    ensure(await evaluate(send, "document.querySelector('.analysis-details').open && document.querySelectorAll('tbody tr').length===3 && document.querySelector('tbody tr').lastElementChild.textContent==='0' && document.querySelector('tbody tr:last-child').lastElementChild.textContent==='Нет данных'"), 'Source table or null/zero values missing.')
    if (width < 640) {
      ensure(await evaluate(send, "document.querySelector('.table-scroll').scrollWidth>document.querySelector('.table-scroll').clientWidth"), 'Mobile table should scroll within its region.')
      await evaluate(send, "document.querySelector('.table-scroll').focus()")
      await key(send, 'ArrowRight', 'ArrowRight', 39)
      await waitFor(send, "document.querySelector('.table-scroll').scrollLeft>0", 'Keyboard table scrolling failed')
    }
    results.push(await snapshot(send, `channel-loaded-${width}`, width))
    await activate(send, '.back-link')
    await waitFor(send, `document.querySelectorAll('.video-card').length===3 && document.activeElement.id===${JSON.stringify(`analysis-${videos[0].id}`)}`, 'Return did not restore results/origin focus')
    ensure(await evaluate(send, "document.getElementById('search-query').value==='детерминированный поиск'"), 'Return lost search draft.')
    await frames(send)
    await Promise.all([...observed.interceptions])
    ensure(observed.searchRequests === 1 && observed.channelRequests === 1 && observed.mockedApiRequests === 2, 'Return triggered extra API calls.')
    ensure(observed.liveApiResponses === 0 && observed.unexpectedApiRequests.length === 0, 'A live/unexpected API response escaped fixture handling.')
    ensure(observed.blockedExternalRequests.length === 0, `Unexpected external HTTP attempt: ${observed.blockedExternalRequests.join(', ')}`)
    ensure(observed.runtimeErrors.length === 0 && observed.consoleErrors.length === 0 && observed.interceptionErrors.length === 0,
      `Browser/chart/interception errors: ${JSON.stringify(observed, (key, value) => value instanceof Set ? [...value] : value)}`)
    ensure(observed.apiNetworkIds.size === 2 && [...observed.apiNetworkIds].every(id => observed.mockNetworkIds.has(id)), 'An API request was not intercepted and mocked.')
    const { apiNetworkIds, mockNetworkIds, interceptions, ...counts } = observed
    const row = { name: `flow-${width}`, keyboardSkip: true, keyboardDetails: true, keyboardReturnFocus: true,
      mobileKeyboardAndTouchFilters: width < 640, ...counts }
    results.push(row)
    console.log(JSON.stringify(row))
    await call('Target.disposeBrowserContext', { browserContextId })
    observations.delete(sessionId)
  }
  await writeFile(new URL('browser-report.json', output), JSON.stringify({ baseUrl: url.origin,
    fixture: 'CDP Fetch only; no live API, YouTube or thumbnails', results }, null, 2) + '\n')
  console.log('Browser verification passed.')
} finally {
  clearTimeout(deadline)
  chrome.kill()
}

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const output = new URL('verification/', root)
const url = new URL(process.env.FRONTEND_URL ?? 'http://127.0.0.1:5173')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  throw new Error('Browser verification requires a local frontend URL.')
}
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
await mkdir(output, { recursive: true })

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

chrome.stdio[4].on('data', data => {
  buffer += data.toString()
  let end
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
      continue
    }
    const observed = observations.get(message.sessionId)
    if (!observed) continue
    if (message.method === 'Runtime.exceptionThrown') observed.runtimeErrors += 1
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') observed.consoleErrors += 1
    if (message.method === 'Network.requestWillBeSent') {
      const requestUrl = new URL(message.params.request.url)
      if (requestUrl.pathname.startsWith('/api/')) observed.apiRequests += 1
      if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== url.origin) observed.externalRequests += 1
    }
  }
})

function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
  })
}

chrome.on('error', error => {
  for (const waiter of pending.values()) waiter.reject(error)
  pending.clear()
})
chrome.on('exit', (code, signal) => {
  if (pending.size === 0) return
  const error = new Error(`Chrome exited before responding (${code ?? signal}). ${startupErrors}`)
  for (const waiter of pending.values()) waiter.reject(error)
  pending.clear()
})

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

const deadline = setTimeout(() => {
  for (const waiter of pending.values()) waiter.reject(new Error('Browser verification timed out.'))
  pending.clear()
  chrome.kill()
}, 90000)

async function waitForPage(send, title) {
  const expression = `new Promise((resolve,reject)=>{const end=performance.now()+15000;function check(){const heading=document.getElementById('page-title');if(heading&&heading.textContent===${JSON.stringify(title)}&&document.getElementById('app').__vue_app__){resolve(true);return}if(performance.now()>end){reject(new Error('Application did not mount'));return}requestAnimationFrame(check)}check()})`
  const evaluated = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  ensure(!evaluated.exceptionDetails, 'Application mount check failed.')
}

try {
  const channelId = 'UC_' + 'a'.repeat(61)
  for (const [name, width, path, title] of [
    ['search-desktop', 1440, '/', 'Поиск видео'],
    ['search-mobile', 390, '/', 'Поиск видео'],
    ['search-small', 320, '/', 'Поиск видео'],
    ['channel-desktop', 1440, `/channels/${channelId}?videoId=video_sample`, 'Анализ канала'],
    ['channel-mobile', 390, `/channels/${channelId}?videoId=video_sample`, 'Анализ канала'],
    ['channel-small', 320, `/channels/${channelId}?videoId=video_sample`, 'Анализ канала'],
    ['not-found-mobile', 390, '/settings', 'Страница не найдена'],
  ]) {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
    const observed = { runtimeErrors: 0, consoleErrors: 0, apiRequests: 0, externalRequests: 0 }
    observations.set(sessionId, observed)
    const send = (method, params) => call(method, params, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 640 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Network.enable')
    await send('Page.navigate', { url: new URL(path, url).href })
    await waitForPage(send, title)
    await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' })
    const { result } = await send('Runtime.evaluate', {
      expression: `JSON.stringify({width:innerWidth,documentWidth:document.documentElement.scrollWidth,title:document.title,heading:document.getElementById('page-title').textContent,focus:document.activeElement.id,language:document.documentElement.lang,pinia:!!document.getElementById('app').__vue_app__.config.globalProperties.$pinia,navigationLinks:document.querySelectorAll('.nav-link').length,bodyBackground:getComputedStyle(document.body).backgroundColor,bodyFontSize:getComputedStyle(document.body).fontSize,clipped:[...document.querySelectorAll('main *')].filter(element=>element.getBoundingClientRect().right>innerWidth+1).map(element=>element.tagName).slice(0,8),smallTargets:[...document.querySelectorAll('nav a,a.text-action')].filter(element=>element.getBoundingClientRect().height<44).length})`,
      returnByValue: true,
    })
    const check = JSON.parse(result.value)
    ensure(check.documentWidth === width && check.clipped.length === 0, `${name}: horizontal overflow.`)
    ensure(check.focus === 'page-title', `${name}: page heading focus missing.`)
    ensure(check.pinia && check.navigationLinks === 1, `${name}: application plugins/navigation missing.`)
    ensure(check.smallTargets === 0 && check.language === 'ru', `${name}: target size or language mismatch.`)
    ensure(check.bodyBackground === 'rgb(23, 24, 28)' && check.bodyFontSize === '16px', `${name}: theme mismatch.`)
    ensure(observed.runtimeErrors === 0 && observed.consoleErrors === 0, `${name}: browser errors.`)
    ensure(observed.apiRequests === 0 && observed.externalRequests === 0, `${name}: unexpected network request.`)
    const { cssContentSize } = await send('Page.getLayoutMetrics')
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: cssContentSize.height, scale: 1 },
    })
    await writeFile(new URL(`${name}.png`, output), Buffer.from(data, 'base64'))

    if (name === 'search-desktop') {
      await send('Runtime.evaluate', { expression: "document.querySelector('.skip-link').focus()" })
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      const focused = await send('Runtime.evaluate', { expression: "document.activeElement.id", returnByValue: true })
      ensure(focused.result.value === 'main-content', 'Keyboard skip link failed.')
      check.keyboardSkipLink = true
    }
    if (name === 'channel-desktop') {
      await send('Runtime.evaluate', { expression: "document.querySelector('a.text-action').focus()" })
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await waitForPage(send, 'Поиск видео')
      check.keyboardInternalReturn = true
      ensure(observed.apiRequests === 0, 'Keyboard return unexpectedly called API.')
    }
    const row = { name, ...check, ...observed }
    results.push(row)
    console.log(JSON.stringify(row))
    await call('Target.closeTarget', { targetId })
    observations.delete(sessionId)
  }
  await writeFile(new URL('browser-report.json', output), JSON.stringify({ baseUrl: url.origin, results }, null, 2) + '\n')
  console.log('Browser verification passed.')
} finally {
  clearTimeout(deadline)
  chrome.kill()
}

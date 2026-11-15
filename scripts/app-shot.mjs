import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.STELLA_URL ?? 'http://127.0.0.1:8788'
const outDir = path.join(root, 'design', 'screenshots')
mkdirSync(outDir, { recursive: true })

const executablePath = [
  process.env.CHROMIUM_PATH,
  '/home/mei/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell',
  '/home/mei/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
].find((candidate) => candidate && existsSync(candidate))
if (!executablePath) {throw new Error('No Chromium found')}

const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

const shot = async (name, target = page) => {
  await page.waitForTimeout(350)
  await target.screenshot({ path: path.join(outDir, `app-${name}.png`) })
}

const go = async (hash) => {
  const response = await page.goto(`${base}/#${hash}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
  if (response && response.status() >= 400) {
    throw new Error(`navigation ${hash} returned ${response.status()} (${page.url()})`)
  }
}

await go('/chat')
await shot('chat-empty')

// Ask through the real gateway + mock upstream.
const input = page.getByRole('textbox').first()
if ((await input.count()) === 0) {
  await page.screenshot({ path: path.join(outDir, 'app-chat-missing-input.png') })
  const text = (await page.locator('body').innerText()).slice(0, 400)
  throw new Error(`no chat input; body starts: ${text.replaceAll('\n', ' | ')}`)
}
await input.fill('What is the refund window for annual plans, and who approves exceptions?')
await input.press('Enter')
await page.getByText(/14 days/i).first().waitFor({ timeout: 20000 })
await page.getByRole('button', { name: 'Trace' }).first().waitFor({ timeout: 10000 })
await shot('chat-answer')

await page.getByRole('button', { name: 'Trace' }).first().click()
await page.waitForTimeout(900)
await shot('trace-detail')

await go('/quality')
await shot('quality')

await go('/traces')
await shot('traces')

await go('/datasets')
await shot('datasets')
const datasetLink = page.getByText('support', { exact: true }).first()
if (await datasetLink.count()) {
  await datasetLink.click()
  await page.waitForTimeout(600)
  await shot('dataset-detail')
}

await go('/runs')
await shot('runs')
const runRow = page.locator('tbody tr').first()
if (await runRow.count()) {
  await runRow.click()
  await page.waitForTimeout(700)
  await shot('run-detail')
}

await go('/improve')
await shot('improve')

// Dark mode quality board
await page.addInitScript(() => localStorage.setItem('chat-demo:theme-preference', 'dark'))
await page.reload({ waitUntil: 'networkidle' })
await go('/quality')
await shot('quality-dark')

await browser.close()
if (errors.length > 0) {
  console.error('page errors:', errors.slice(0, 5))
  process.exit(1)
}
console.log('app screenshots written to', outDir)

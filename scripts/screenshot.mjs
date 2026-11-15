import { chromium } from 'playwright-core'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  process.env.CHROMIUM_PATH,
  '/home/mei/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell',
  '/home/mei/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
].filter(Boolean)
const executablePath = candidates.find((candidate) => existsSync(candidate))
if (!executablePath) {
  console.error('No Chromium found. Set CHROMIUM_PATH to a Chromium/Chrome executable.')
  process.exit(2)
}

const target = process.argv[2] ?? 'design/stella.html'
const outDir = path.join(root, 'design', 'screenshots')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote', '--single-process'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
await page.goto(`file://${path.resolve(root, target)}`, { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(150)

const base = path.basename(target, path.extname(target))
await page.screenshot({ path: path.join(outDir, `${base}-top.png`) })
await page.screenshot({ path: path.join(outDir, `${base}-full.png`), fullPage: true })

const sections = page.locator('section')
const count = await sections.count()
for (let index = 0; index < count; index += 1) {
  await sections.nth(index).screenshot({ path: path.join(outDir, `${base}-section-${index + 1}.png`) })
}

console.log(`screenshots: ${outDir} (${count} sections)`)
await browser.close()

import { mkdir, writeFile } from 'node:fs/promises'
import type { Browser, BrowserContext, Page } from '@playwright/test'

/** Where each test of a coverage run leaves the code it ran (merged by scripts/e2e-coverage.mjs). */
export const E2E_COVERAGE_DIR = 'node_modules/.cache/e2e-coverage'

/** How often a page's record is taken out while the test runs (see `track`). */
const POLL_MS = 300

type Rewritable = (...args: unknown[]) => Promise<unknown>

interface Entry {
  file: string | undefined
  length: number
  functions: unknown
}

/**
 * Records which of the app's scripts a test ran (V8 block coverage, Chromium only), for its own `page` and for the
 * pages of any context the test makes itself (`browser.newContext`: the English UI, a second signed-in account).
 */
export class WebCoverage {
  private readonly entries: Entry[] = []
  private readonly open = new Map<Page, () => Promise<void>>()
  private restore: (() => void) | undefined

  /** Starts recording `page`; what it ran is taken out at the latest when `save` is called. */
  async track(page: Page): Promise<void> {
    let active = true
    const begin = () => page.coverage.startJSCoverage({ resetOnNavigation: false })
    const collect = async () => {
      if (!active) return
      for (const e of await page.coverage.stopJSCoverage().catch(() => [])) {
        if (/\/assets\/[^/]+\.js$/.test(new URL(e.url).pathname)) {
          this.entries.push({
            file: new URL(e.url).pathname.split('/').pop(),
            length: e.source?.length ?? 0,
            functions: e.functions,
          })
        }
      }
    }
    // Start and stop calls are made one after the other: two at once leave the profiler in a state of its own.
    let queue: Promise<unknown> = Promise.resolve()
    const later = (task: () => Promise<unknown>) => {
      queue = queue.then(task, task).catch(() => undefined)
      return queue
    }
    await begin()
    // A full navigation destroys the page's scripts, and V8 drops what they ran along with them: whatever the
    // page ran is taken out before the test leaves it, or only the last page of a test would be counted.
    for (const method of ['goto', 'reload'] as const) {
      const original = page[method].bind(page) as Rewritable
      page[method] = (async (...args: unknown[]) => {
        await later(async () => {
          await collect()
          await begin().catch(() => undefined)
        })
        return original(...args)
      }) as never
    }
    // The test's own `goto` is not the only cause: the app reloads itself (after a sign-in, after saving settings), and
    // a request cannot be held back to take the record first (recording cannot be switched on again while it is). So
    // the record is also taken out every POLL_MS: a document that is replaced has, at worst, lost the last POLL_MS.
    const timer = setInterval(() => {
      void later(async () => {
        await collect()
        if (active) await begin().catch(() => undefined)
      })
    }, POLL_MS)
    this.open.set(page, async () => {
      clearInterval(timer)
      await later(collect)
      active = false
    })
  }

  /** Records the pages of every context the test makes with `browser.newContext`, taking each page's record out
   * before its context closes (a closed page can no longer be asked). */
  watch(browser: Browser): void {
    const original = browser.newContext
    const newContext = original.bind(browser) as (...args: unknown[]) => Promise<BrowserContext>
    // The browser outlives the test (one per worker): the next test must not find this one's wrapper on it.
    this.restore = () => {
      browser.newContext = original
    }
    browser.newContext = (async (...args: unknown[]) => {
      const context = await newContext(...args)
      const newPage = context.newPage.bind(context)
      const pages: Page[] = []
      context.newPage = async () => {
        const page = await newPage()
        pages.push(page)
        await this.track(page)
        return page
      }
      const close = context.close.bind(context)
      context.close = async (options) => {
        for (const page of pages) await this.open.get(page)?.()
        return close(options)
      }
      return context
    }) as never
  }

  /** Takes out what every tracked page ran and writes the test's record. */
  async save(id: string): Promise<void> {
    this.restore?.()
    for (const flush of this.open.values()) await flush()
    await mkdir(E2E_COVERAGE_DIR, { recursive: true })
    await writeFile(`${E2E_COVERAGE_DIR}/${id}.json`, JSON.stringify(this.entries))
  }
}

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { StatementResult } from '@tsmyadmin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale.ts'
import { ResultsView } from './ResultsView.tsx'

const downloaded = vi.hoisted(() => vi.fn())
vi.mock('@/lib/download.ts', () => ({
  downloadText: downloaded,
  safeFilename: (base: string, ext: string) => `${base}.${ext}`,
}))

/** One result set holding a value a spreadsheet would run as a formula. */
const results: StatementResult[] = [
  {
    kind: 'rows',
    sql: 'SELECT note FROM t',
    durationMs: 1,
    result: {
      columns: [{ name: 'note', dataType: 'varchar' }],
      rows: [['=1+1']],
      truncated: false,
    },
  },
]

/** jsdom here has no localStorage; the preference path needs one to be exercised at all. */
function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  }
}

describe('ResultsView downloads', () => {
  beforeEach(() => {
    downloaded.mockClear()
    vi.stubGlobal('localStorage', memoryStorage())
  })

  it('writes the value unchanged by default', async () => {
    render(<ResultsView results={results} maxRows={1000} />)
    await userEvent.click(screen.getByRole('button', { name: new RegExp(locale.sql.downloadCsv) }))
    expect(downloaded.mock.calls[0]?.[1]).toBe('note\r\n=1+1\r\n')
  })

  it('neutralises formulas once the option is ticked, and remembers it', async () => {
    const { unmount } = render(<ResultsView results={results} maxRows={1000} />)
    await userEvent.click(screen.getByRole('checkbox', { name: locale.export.csvSafe }))
    await userEvent.click(screen.getByRole('button', { name: new RegExp(locale.sql.downloadCsv) }))
    // The leading apostrophe is what stops a spreadsheet evaluating the cell.
    expect(downloaded.mock.calls[0]?.[1]).toBe("note\r\n'=1+1\r\n")
    unmount()

    // A second visit keeps the choice.
    render(<ResultsView results={results} maxRows={1000} />)
    expect(screen.getByRole('checkbox', { name: locale.export.csvSafe })).toBeChecked()
  })

  it('applies the same option to a copy for a spreadsheet', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ResultsView results={results} maxRows={1000} />)
    await userEvent.click(screen.getByRole('checkbox', { name: locale.export.csvSafe }))
    await userEvent.click(screen.getByRole('button', { name: new RegExp(locale.sql.copy) }))
    expect(writeText).toHaveBeenCalledWith("note\n'=1+1")
    Reflect.deleteProperty(navigator, 'clipboard')
  })
})

const firstHidden = () =>
  document.querySelector('section[aria-label="文 1"]')?.classList.contains('print:hidden') ?? false

function twoResults(): StatementResult[] {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [i + 1])
  return [1, 300].map((n) => ({
    kind: 'rows',
    sql: 'SELECT n',
    durationMs: 1,
    result: { columns: [{ name: 'n', dataType: 'int' }], rows: rows(n), truncated: false },
  }))
}

describe('ResultsView printing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lays out every row of a long result for paper, not just the window on screen', async () => {
    const long: StatementResult[] = [
      {
        kind: 'rows',
        sql: 'SELECT n FROM s',
        durationMs: 1,
        result: {
          columns: [{ name: 'n', dataType: 'int' }],
          rows: Array.from({ length: 300 }, (_, i) => [i + 1]),
          truncated: false,
        },
      },
    ]
    render(<ResultsView results={long} maxRows={1000} />)
    const table = screen.getByRole('table')
    // On screen a result this long is virtualised: only a window of rows exists (none at all without layout).
    expect(table.querySelectorAll('tbody tr[data-index]').length).toBeLessThan(300)
    await act(async () => {
      window.dispatchEvent(new Event('beforeprint'))
    })
    expect(screen.getByRole('table').querySelectorAll('tbody tr[data-index]')).toHaveLength(300)
    await act(async () => {
      window.dispatchEvent(new Event('afterprint'))
    })
    expect(screen.getByRole('table').querySelectorAll('tbody tr[data-index]').length).toBeLessThan(300)
  })

  it('lays the rows out while its Print button prints, and puts the screen back even without afterprint', async () => {
    const long: StatementResult[] = [
      {
        kind: 'rows',
        sql: 'SELECT 1',
        durationMs: 1,
        result: { columns: [{ name: 'a', dataType: 'int' }], rows: [[1]], truncated: false },
      },
      {
        kind: 'rows',
        sql: 'SELECT n FROM s',
        durationMs: 1,
        result: {
          columns: [{ name: 'n', dataType: 'int' }],
          rows: Array.from({ length: 300 }, (_, i) => [i + 1]),
          truncated: false,
        },
      },
    ]
    let during: { rows: number; firstHidden: boolean } | null = null
    // A browser that never fires afterprint: print() just returns.
    vi.spyOn(window, 'print').mockImplementation(() => {
      during = {
        rows: document.querySelectorAll('section[aria-label="文 2"] tbody tr[data-index]').length,
        firstHidden: document.querySelector('section[aria-label="文 1"]')?.classList.contains('print:hidden') ?? false,
      }
    })
    render(<ResultsView results={long} maxRows={1000} />)
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`文 2.*${locale.sql.print}`) }))
    expect(during).toEqual({ rows: 300, firstHidden: true })
    // Returned without afterprint: the dialog may still be open (a browser whose print() does not block), so the
    // paper layout stays until the user is back on the page.
    expect(firstHidden()).toBe(true)
    await userEvent.keyboard('{Shift}')
    // Now a Ctrl+P prints every statement again, and the screen is windowed again.
    expect(firstHidden()).toBe(false)
    expect(document.querySelectorAll('section[aria-label="文 2"] tbody tr[data-index]').length).toBeLessThan(300)
  })

  it('puts the screen back as soon as print() returns in a browser that reports the print finished', async () => {
    vi.spyOn(window, 'print').mockImplementation(() => {
      window.dispatchEvent(new Event('afterprint'))
    })
    const { container } = render(<ResultsView results={twoResults()} maxRows={1000} />)
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`文 2.*${locale.sql.print}`) }))
    expect(container.querySelector('section[aria-label="文 1"]')?.classList.contains('print:hidden')).toBe(false)
  })
})

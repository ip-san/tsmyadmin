import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { StatementResult } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})

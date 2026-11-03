import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DiagnosticReport as Report } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { DiagnosticReport } from './DiagnosticReport.tsx'

const t = locale.diagnostics

let report: Report
vi.mock('@/lib/queries.ts', () => ({
  diagnosticsQuery: () => ({ queryKey: ['diagnostics'], queryFn: async () => report }),
}))
const opened: { db: string; sql: string; then: string | undefined }[] = []
vi.mock('@/lib/open-in-console.ts', () => ({
  useOpenInDatabaseConsole: (db: string) => (sql: string, then?: string) => opened.push({ db, sql, then }),
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DiagnosticReport kind="statements" title="Statements" />
    </QueryClientProvider>
  )

beforeEach(() => {
  opened.length = 0
})

describe('DiagnosticReport', () => {
  it("opens a logged statement's plan in the database it ran in, drawn at once where its values were logged", async () => {
    report = {
      status: 'ok',
      columns: ['statement', 'database', 'runs', 'totalSeconds', 'maxSeconds', 'rows'],
      rows: [
        ['SELECT * FROM orders WHERE id = 7', 'shop', '3', '1.5', '0.9', '3'],
        ['SELECT * FROM users WHERE id = $1', 'crm', '9', '0.5', '0.1', '9'],
      ],
      text: null,
    }
    mount()
    await userEvent.click(await screen.findByRole('button', { name: t.planLabel(1) }))
    await userEvent.click(screen.getByRole('button', { name: t.planLabel(2) }))
    expect(opened).toEqual([
      { db: 'shop', sql: 'SELECT * FROM orders WHERE id = 7', then: 'plan' },
      // Its values were not logged: given in the SQL tab first, then drawn.
      { db: 'crm', sql: `-- ${t.fillValues}\nSELECT * FROM users WHERE id = :p1`, then: undefined },
    ])
  })

  it('offers no plan for what EXPLAIN does not take, nor where the database is not known', async () => {
    report = {
      status: 'ok',
      columns: ['statement', 'database', 'runs', 'totalSeconds', 'maxSeconds', 'rows'],
      rows: [
        ['COMMIT', 'shop', '30', '0.1', '0.01', '0'],
        ['SELECT 1', null, '1', '0.1', '0.1', '1'],
      ],
      text: null,
    }
    mount()
    expect(await screen.findByRole('table', { name: 'Statements' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t.plan })).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('offers no plan in a report that does not say the database', async () => {
    report = { status: 'ok', columns: ['statement', 'runs'], rows: [['SELECT 1', '4']], text: null }
    mount()
    expect(await screen.findByRole('table', { name: 'Statements' })).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

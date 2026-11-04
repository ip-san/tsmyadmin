import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { DiagnosticReport } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { RecentStatements } from './RecentStatements.tsx'

let report: DiagnosticReport
vi.mock('@/lib/queries.ts', () => ({
  recentStatementsQuery: () => ({ queryKey: ['recent'], queryFn: async () => report }),
  sessionQuery: { queryKey: ['session'], queryFn: async () => ({ dialect: 'postgres', serverDatabase: 'postgres' }) },
  mutations: {},
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecentStatements />
    </QueryClientProvider>
  )

describe('RecentStatements', () => {
  it("says why other users' statements are left out", async () => {
    report = { status: 'ok', columns: ['statement', 'runs'], rows: [], text: null, othersHidden: true }
    mount()
    expect(await screen.findByText(locale.diagnostics.recent.othersHidden)).toBeInTheDocument()
  })

  it('says nothing of it where every statement is readable', async () => {
    report = { status: 'ok', columns: ['statement', 'runs'], rows: [], text: null }
    mount()
    expect(await screen.findByText(locale.diagnostics.recent.waiting)).toBeInTheDocument()
    expect(screen.queryByText(locale.diagnostics.recent.othersHidden)).toBeNull()
  })
})

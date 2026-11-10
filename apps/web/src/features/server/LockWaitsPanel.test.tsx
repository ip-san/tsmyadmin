import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LockWait, LockWaitReport } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { LockWaitsPanel } from './LockWaitsPanel.tsx'

const t = locale.server

const wait = (blocked: string, blocking: string, table: string | null = 'orders'): LockWait => ({
  blocked: { id: blocked, user: 'app', database: 'shop', waitSec: 3, query: 'UPDATE orders SET n = 1' },
  blocking: {
    id: blocking,
    user: 'app',
    database: 'shop',
    state: null,
    idleInTransaction: false,
    transactionSec: 9,
    query: null,
  },
  table,
  mode: 'X',
})

let report: LockWaitReport
vi.mock('@/lib/queries.ts', () => ({
  lockWaitsQuery: { queryKey: ['lock-waits'], queryFn: async () => report },
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LockWaitsPanel every={0} onKill={vi.fn()} />
    </QueryClientProvider>
  )

const connections = { current: 3, max: 100, idleInTransaction: 0 }

describe('LockWaitsPanel', () => {
  it('opens on the table, and switches to the diagram with the same waits in words', async () => {
    // Two rows for one pair (two tables locked): two table rows, one arrow.
    report = { status: 'ok', waits: [wait('2', '1'), wait('2', '1', 'items'), wait('3', '2')], connections }
    mount()
    const asTable = await screen.findByRole('button', { name: t.lockAsTable })
    expect(asTable).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('row')).toHaveLength(4)
    await userEvent.click(screen.getByRole('button', { name: t.lockAsGraph }))
    expect(screen.getByRole('button', { name: t.lockAsGraph })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('img', { name: t.lockGraph })).toBeInTheDocument()
    expect(screen.getByText(t.lockRoot('1', 2))).toBeInTheDocument()
    expect(screen.getByText(t.lockWait('2', '1', 'orders X / items X'))).toBeInTheDocument()
    // No deadlock, so the legend does not explain one.
    expect(screen.queryByText(t.lockLegendDeadlock)).toBeNull()
  })

  it('explains a deadlock in the legend and in words when there is one', async () => {
    report = { status: 'ok', waits: [wait('1', '2'), wait('2', '1')], connections }
    mount()
    await userEvent.click(await screen.findByRole('button', { name: t.lockAsGraph }))
    expect(screen.getByText(t.lockLegendDeadlock)).toBeInTheDocument()
    expect(screen.getByText(t.lockCycle(['1', '2']))).toBeInTheDocument()
  })

  it('offers no switch when nothing waits', async () => {
    report = { status: 'ok', waits: [], connections }
    mount()
    expect(await screen.findByText(t.lockWaitsNone)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t.lockAsGraph })).toBeNull()
  })

  it("says another user's statements cannot be read, in the rows and above them, and only then", async () => {
    const seen = wait('2', '1')
    report = {
      status: 'ok',
      waits: [
        {
          ...seen,
          blocked: { ...seen.blocked, query: null, hidden: true },
          blocking: { ...seen.blocking, transactionSec: null, hidden: true },
        },
      ],
      connections,
    }
    mount()
    expect(await screen.findByText(t.lockWaitsHidden)).toBeInTheDocument()
    expect(screen.getAllByText(t.queryHidden)).toHaveLength(2)
  })

  it('says nothing of it where every statement can be read', async () => {
    report = { status: 'ok', waits: [wait('2', '1')], connections }
    mount()
    expect(await screen.findByRole('table', { name: t.lockWaitsTitle })).toBeInTheDocument()
    expect(screen.queryByText(t.lockWaitsHidden)).toBeNull()
    expect(screen.queryByText(t.queryHidden)).toBeNull()
  })
})

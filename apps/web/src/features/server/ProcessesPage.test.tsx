import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProcessInfo } from '@tsmyadmin/shared'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { ProcessesPage } from './ProcessesPage.tsx'

let processes: ProcessInfo[]
vi.mock('@/lib/queries.ts', () => ({
  processesQuery: { queryKey: ['server', 'processes'], queryFn: async () => processes },
  lockWaitsQuery: {
    queryKey: ['server', 'lock-waits'],
    queryFn: async () => ({ status: 'ok', waits: [], connections: { current: 1, max: 100, idleInTransaction: 0 } }),
  },
  mutations: {},
}))

const mine: ProcessInfo = {
  id: '1',
  user: 'me',
  host: '10.0.0.1',
  database: 'shop',
  state: 'active',
  timeSec: 0,
  query: 'SELECT 1',
  self: true,
}

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProcessesPage />
    </QueryClientProvider>
  )

// jsdom has <dialog> but not its modal methods.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  processes = [mine]
})

describe('ProcessesPage', () => {
  it("says another user's session cannot be read, and how to read it", async () => {
    processes = [
      mine,
      { ...mine, id: '2', user: 'app', host: null, state: null, timeSec: null, query: null, self: false, hidden: true },
    ]
    mount()
    const table = await screen.findByRole('table', { name: locale.server.processesTitle })
    expect(screen.getByText(locale.server.processesHidden)).toBeInTheDocument()
    expect(within(table).getByText(locale.server.queryHidden)).toBeInTheDocument()
    // Asked to end it, the dialog says the statement cannot be read, not that there is none.
    await userEvent.click(screen.getByRole('button', { name: `2: ${locale.server.kill}` }))
    expect(within(await screen.findByRole('dialog')).getByText(locale.server.queryHidden)).toBeInTheDocument()
  })

  it('says nothing of it where every session can be read', async () => {
    mount()
    expect(await screen.findByRole('table', { name: locale.server.processesTitle })).toBeInTheDocument()
    expect(screen.queryByText(locale.server.processesHidden)).toBeNull()
    expect(screen.queryByText(locale.server.queryHidden)).toBeNull()
  })
})

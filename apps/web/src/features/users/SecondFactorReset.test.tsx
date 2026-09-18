import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { accountSecondFactorsQuery, mutations } from '@/lib/queries.ts'
import { SecondFactorResetDialog, useResettableAccounts } from './SecondFactorReset.tsx'

vi.mock('@/lib/queries.ts', () => ({
  sessionQuery: { queryKey: ['session'], queryFn: async () => null, staleTime: Number.POSITIVE_INFINITY },
  accountSecondFactorsQuery: {
    queryKey: ['second-factor', 'accounts'],
    queryFn: vi.fn(async () => ({ accounts: ['alice'] })),
  },
  mutations: { resetSecondFactor: vi.fn(async () => ({ accounts: [] })) },
}))

function withClient(secondFactor: string, ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(['session'], { secondFactor })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return client
}

function Names() {
  return <p>{[...useResettableAccounts()].join(',') || 'none'}</p>
}

describe('useResettableAccounts', () => {
  it('asks only where a second factor can exist at all', async () => {
    withClient('unsupported', <Names />)
    expect(screen.getByText('none')).toBeInTheDocument()
    expect(accountSecondFactorsQuery.queryFn).not.toHaveBeenCalled()
  })

  it('lists the accounts the server says this one may reset', async () => {
    withClient('none', <Names />)
    expect(await screen.findByText('alice')).toBeInTheDocument()
  })
})

describe('SecondFactorResetDialog', () => {
  // jsdom has <dialog> but not its modal methods.
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false
    }
  })

  it('resets only after the confirmation, and closes with the list updated', async () => {
    const onClose = vi.fn()
    const client = withClient('none', <SecondFactorResetDialog user="alice" onClose={onClose} />)
    expect(screen.getByText(/alice の 2 要素認証を解除します/)).toBeInTheDocument()
    expect(mutations.resetSecondFactor).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(vi.mocked(mutations.resetSecondFactor).mock.calls[0]?.[0]).toBe('alice')
    expect(client.getQueryData(['second-factor', 'accounts'])).toEqual({ accounts: [] })
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SecondFactorStatus } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { mutations } from '@/lib/queries.ts'
import { SecondFactorManage } from './SecondFactorManage.tsx'

vi.mock('@/lib/passkeys.ts', () => ({
  passkeysSupported: () => true,
  answerChallenge: vi.fn(async (c: { ticket: string }) => ({ ticket: c.ticket, response: { id: 'k' } })),
  createPasskey: vi.fn(),
}))

vi.mock('@/lib/queries.ts', () => ({
  mutations: {
    passkeyChallenge: vi.fn(async () => ({ ticket: 'proof-ticket', options: {} })),
    disableSecondFactor: vi.fn(async () => ({})),
    removeTotp: vi.fn(),
    removePasskey: vi.fn(),
    beginSecondFactor: vi.fn(),
    beginPasskey: vi.fn(),
    confirmPasskey: vi.fn(),
  },
}))

const status = (passkeys: number): SecondFactorStatus => ({
  state: 'enrolled',
  recoveryCodesLeft: 10,
  totp: true,
  passkeys: Array.from({ length: passkeys }, (_, i) => ({ id: `k${i}`, at: 1_700_000_000_000 })),
  passkeysAvailable: true,
})

function renderManage(s: SecondFactorStatus, onSettled = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <SecondFactorManage status={s} onSettled={onSettled} onTotpSetup={vi.fn()} />
    </QueryClientProvider>
  )
  return onSettled
}

describe('SecondFactorManage', () => {
  it('proves with the code typed, and with a passkey when the field is left empty', async () => {
    const onSettled = renderManage(status(1))
    await userEvent.type(screen.getByLabelText('コード'), '123456')
    await userEvent.click(screen.getByRole('button', { name: '2 要素認証を解除する' }))
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('disabled'))
    expect(vi.mocked(mutations.disableSecondFactor).mock.calls[0]?.[0]).toEqual({ code: '123456' })
    expect(mutations.passkeyChallenge).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '2 要素認証を解除する' }))
    await waitFor(() => expect(mutations.disableSecondFactor).toHaveBeenCalledTimes(2))
    expect(vi.mocked(mutations.disableSecondFactor).mock.calls[1]?.[0]).toMatchObject({
      passkey: { ticket: 'proof-ticket' },
    })
  })

  it('waits for a code where there is no passkey to prove with', async () => {
    renderManage(status(0))
    // Nothing to answer a challenge with: the actions stay off until a code is typed.
    expect(screen.getByRole('button', { name: '2 要素認証を解除する' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('コード'), '123456')
    expect(screen.getByRole('button', { name: '2 要素認証を解除する' })).toBeEnabled()
    // Removing the app would leave nothing to sign in with, so it is only offered alongside a passkey.
    expect(screen.queryByRole('button', { name: '認証アプリを外す' })).not.toBeInTheDocument()
  })
})

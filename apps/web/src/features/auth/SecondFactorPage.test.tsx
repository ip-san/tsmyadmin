import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { copyText } from '@/lib/clipboard.ts'
import { SecondFactorPage } from './SecondFactorPage.tsx'

const state = vi.hoisted(() => ({ value: 'none' as string }))

vi.mock('@/lib/clipboard.ts', () => ({ copyText: vi.fn() }))

vi.mock('@/lib/queries.ts', () => ({
  sessionQuery: { queryKey: ['session'] },
  secondFactorQuery: {
    queryKey: ['second-factor'],
    queryFn: async () => ({ state: state.value, recoveryCodesLeft: 0 }),
  },
  mutations: {
    beginSecondFactor: async () => ({
      secret: 'A'.repeat(32),
      uri: 'otpauth://totp/tsmyadmin:root@db:3306?secret=AAAA',
      recoveryCodes: ['AAAAABBBBB'],
      qr: ['101', '010', '101'],
    }),
    confirmSecondFactor: async () => ({ state: 'enrolled', recoveryCodesLeft: 1 }),
    disableSecondFactor: async () => ({ state: 'none', recoveryCodesLeft: 0 }),
  },
}))

function renderPage(secondFactorState: string) {
  state.value = secondFactorState
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SecondFactorPage />
    </QueryClientProvider>
  )
}

describe('SecondFactorPage', () => {
  it('says why it is unavailable instead of offering an enrolment that cannot be kept', async () => {
    renderPage('unsupported')
    expect(await screen.findByText(/この配備では 2 要素認証を使えません/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '2 要素認証を登録する' })).not.toBeInTheDocument()
  })

  it('can start over once a secret has been shown', async () => {
    // The server only holds the secret for ten minutes. Without a way back, an enrolment left open too long
    // would keep showing a dead key with no control but a page reload.
    renderPage('none')
    await userEvent.click(await screen.findByRole('button', { name: '2 要素認証を登録する' }))
    expect(await screen.findByText('A'.repeat(32))).toBeInTheDocument()
    // Drawn from the rows the server sent: one square per dark module, nothing inserted as markup.
    const qr = screen.getByRole('img', { name: '認証アプリで読み取る QR コード' })
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(
      'M0 0h1v1h-1zM2 0h1v1h-1zM1 1h1v1h-1zM0 2h1v1h-1zM2 2h1v1h-1z'
    )
    await userEvent.click(screen.getByRole('button', { name: 'やり直す' }))
    expect(await screen.findByRole('button', { name: '2 要素認証を登録する' })).toBeInTheDocument()
    expect(screen.queryByText('A'.repeat(32))).not.toBeInTheDocument()
  })

  it('says the enrolment worked and moves focus off the controls that just disappeared', async () => {
    renderPage('none')
    await userEvent.click(await screen.findByRole('button', { name: '2 要素認証を登録する' }))
    await userEvent.type(await screen.findByLabelText('コード'), '123456')
    await userEvent.click(screen.getByRole('button', { name: '登録を完了する' }))
    // The confirm button is gone with its form: without this, focus falls to <body> and nothing is announced.
    expect(await screen.findByText(/2 要素認証を有効にしました/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '2 要素認証' })).toHaveFocus()
  })

  it('says so when the recovery codes could not be copied', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('denied'))
    renderPage('none')
    await userEvent.click(await screen.findByRole('button', { name: '2 要素認証を登録する' }))
    await userEvent.click(await screen.findByRole('button', { name: '回復用コードをコピー' }))
    expect(await screen.findByText(/コピーできませんでした/)).toBeInTheDocument()
  })
})

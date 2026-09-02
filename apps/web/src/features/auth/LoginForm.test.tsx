import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from './LoginForm.tsx'

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('LoginForm', () => {
  // jsdom under vitest exposes no localStorage on the global object here: give the form an in-memory one.
  beforeEach(() => {
    const data = new Map<string, string>()
    const memory = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    }
    Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true, writable: true })
  })

  it('prefills the last successful connection (never the password) after a session expires', async () => {
    const onLogin = vi.fn().mockResolvedValue({})
    const first = wrap(<LoginForm onLogin={onLogin} />)
    await userEvent.selectOptions(screen.getByLabelText('サーバー種別'), 'postgres')
    await userEvent.clear(screen.getByLabelText('ホスト'))
    await userEvent.type(screen.getByLabelText('ホスト'), 'db.internal')
    await userEvent.type(screen.getByLabelText('ユーザー名'), 'alice')
    await userEvent.type(screen.getByLabelText('パスワード'), 'pw')
    await userEvent.type(screen.getByLabelText('データベース'), 'app')
    await userEvent.click(screen.getByRole('button', { name: '接続する' }))
    await waitFor(() => expect(onLogin).toHaveBeenCalled())
    first.unmount()
    wrap(<LoginForm onLogin={vi.fn()} />)
    expect(screen.getByLabelText('サーバー種別')).toHaveValue('postgres')
    expect(screen.getByLabelText('ホスト')).toHaveValue('db.internal')
    expect(screen.getByLabelText('ポート')).toHaveValue(5432)
    expect(screen.getByLabelText('ユーザー名')).toHaveValue('alice')
    expect(screen.getByLabelText('データベース')).toHaveValue('app')
    expect(screen.getByLabelText('パスワード')).toHaveValue('')
    expect(localStorage.getItem('tsmyadmin.pref.login.last') ?? '').not.toContain('pw')
  })

  it('submits the connection request with a numeric port and omits an empty database', async () => {
    const onLogin = vi.fn().mockResolvedValue({})
    wrap(<LoginForm onLogin={onLogin} />)
    await userEvent.type(screen.getByLabelText('ユーザー名'), 'root')
    await userEvent.type(screen.getByLabelText('パスワード'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: '接続する' }))
    expect(onLogin).toHaveBeenCalledWith({
      dialect: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'pw',
    })
  })

  it('switches the default port when the dialect changes, unless the user edited it', async () => {
    wrap(<LoginForm onLogin={vi.fn()} />)
    const port = screen.getByLabelText('ポート')
    await userEvent.selectOptions(screen.getByLabelText('サーバー種別'), 'postgres')
    expect(port).toHaveValue(5432)
    await userEvent.clear(port)
    await userEvent.type(port, '15433')
    await userEvent.selectOptions(screen.getByLabelText('サーバー種別'), 'mysql')
    expect(port).toHaveValue(15433)
  })

  it('selects the first preset, fixes its fields and can switch back to manual entry', async () => {
    const onLogin = vi.fn().mockResolvedValue({})
    wrap(
      <LoginForm
        onLogin={onLogin}
        presets={[
          { name: 'prod', dialect: 'postgres', host: 'db.internal', port: 5432, database: 'app' },
          { name: 'legacy', dialect: 'mysql', host: 'legacy.internal', port: 3306 },
        ]}
      />
    )
    expect(screen.getByLabelText('ホスト')).toHaveValue('db.internal')
    expect(screen.getByLabelText('ホスト')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('サーバー種別')).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('接続先'), 'legacy')
    expect(screen.getByLabelText('ポート')).toHaveValue(3306)
    await userEvent.type(screen.getByLabelText('ユーザー名'), 'root')
    await userEvent.click(screen.getByRole('button', { name: '接続する' }))
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({
        dialect: 'mysql',
        host: 'legacy.internal',
        port: 3306,
        user: 'root',
        password: '',
      })
    )
    await userEvent.selectOptions(screen.getByLabelText('接続先'), '')
    expect(screen.getByLabelText('ホスト')).not.toHaveAttribute('readonly')
  })

  it('shows the error returned by the server', async () => {
    const onLogin = vi
      .fn()
      .mockRejectedValue({ code: 'AUTH_FAILED', message: 'denied', detail: 'Access denied for root' })
    wrap(<LoginForm onLogin={onLogin} />)
    await userEvent.type(screen.getByLabelText('ユーザー名'), 'root')
    await userEvent.click(screen.getByRole('button', { name: '接続する' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('認証に失敗しました: Access denied for root')
  })
})

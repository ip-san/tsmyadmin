import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ServerPreset } from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from './LoginForm.tsx'
import { describePresetChanges } from './PresetStatus.tsx'

/**
 * The login screen re-reads the server list while Docker discovery is on: containers started or stopped join or
 * leave it under the form. What is selected and typed must stay, and a selected container that leaves is said so.
 */

const shop: ServerPreset = { name: 'docker: shop/db', dialect: 'mysql', host: '127.0.0.1', port: 13306 }
const blog: ServerPreset = { name: 'docker: blog/pg', dialect: 'postgres', host: '127.0.0.1', port: 15432 }
const auto: ServerPreset = { ...shop, name: 'docker: auto/db', autoLogin: true }

function setup(presets: ServerPreset[]) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const onLogin = vi.fn().mockResolvedValue({})
  const view = render(<LoginForm onLogin={onLogin} presets={presets} />, { wrapper })
  return { onLogin, update: (next: ServerPreset[]) => view.rerender(<LoginForm onLogin={onLogin} presets={next} />) }
}

describe('LoginForm while the server list changes', () => {
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

  it('keeps the selection and what was typed when a container joins the list, and says it joined', async () => {
    const { onLogin, update } = setup([shop])
    await userEvent.type(screen.getByLabelText('ユーザー名'), 'alice')
    await userEvent.type(screen.getByLabelText('パスワード'), 'pw')
    // Sorted by name, the new one comes first: the selection must not follow the first option.
    update([blog, shop])
    expect(screen.getByLabelText('接続先')).toHaveValue('docker: shop/db')
    expect(screen.getByLabelText('ユーザー名')).toHaveValue('alice')
    expect(screen.getByLabelText('パスワード')).toHaveValue('pw')
    expect(screen.getByRole('status')).toHaveTextContent('接続先に追加されました: docker: blog/pg')
    await userEvent.click(screen.getByRole('button', { name: '接続する' }))
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({
        dialect: 'mysql',
        host: '127.0.0.1',
        port: 13306,
        user: 'alice',
        password: 'pw',
      })
    )
  })

  it('keeps manual entry when the first container appears on an empty list', async () => {
    const { update } = setup([])
    await userEvent.clear(screen.getByLabelText('ホスト'))
    await userEvent.type(screen.getByLabelText('ホスト'), 'db.local')
    update([shop])
    expect(screen.getByLabelText('接続先')).toHaveValue('')
    expect(screen.getByLabelText('ホスト')).toHaveValue('db.local')
    expect(screen.getByLabelText('ホスト')).not.toHaveAttribute('readonly')
  })

  it('says the selected container left, keeps it selected and its form, and waits for it to come back', async () => {
    const { update } = setup([auto, blog])
    expect(screen.queryByLabelText('ユーザー名')).toBeNull()
    update([blog])
    // Still selected (an option of its own, not the first one shown in its place), and the form keeps its shape.
    expect(screen.getByLabelText('接続先')).toHaveValue('docker: auto/db')
    expect(screen.getByRole('option', { name: 'docker: auto/db（一覧にありません）' })).toBeInTheDocument()
    expect(screen.queryByLabelText('ユーザー名')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('docker: auto/db が一覧から消えました')
    expect(screen.getByRole('button', { name: '接続する' })).toBeDisabled()
    // Back (restarted): usable as it is, without choosing it again.
    update([auto, blog])
    expect(screen.getByRole('button', { name: '接続する' })).toBeEnabled()
    expect(screen.queryByRole('option', { name: /一覧にありません/ })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('接続先に追加されました: docker: auto/db')
  })

  it('lets the user leave a container that is gone for another one or for manual entry', async () => {
    const { update } = setup([shop, blog])
    update([blog])
    await userEvent.selectOptions(screen.getByLabelText('接続先'), 'docker: blog/pg')
    expect(screen.getByLabelText('ポート')).toHaveValue(15432)
    expect(screen.queryByRole('option', { name: /一覧にありません/ })).toBeNull()
    expect(screen.getByRole('button', { name: '接続する' })).toBeEnabled()
  })
})

describe('describePresetChanges', () => {
  it('names what joined and what left, and says nothing when only the order changed', () => {
    expect(describePresetChanges(['a', 'b'], ['b', 'a'])).toBe('')
    expect(describePresetChanges(['a'], ['a', 'b', 'c'])).toBe('接続先に追加されました: b, c')
    expect(describePresetChanges(['a', 'b'], ['c'])).toBe('接続先に追加されました: c 接続先から消えました: a, b')
  })
})

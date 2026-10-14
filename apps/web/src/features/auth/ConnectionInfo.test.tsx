import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ServerPreset } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '@/lib/clipboard.ts'
import { ConnectionInfo } from './ConnectionInfo.tsx'

vi.mock('@/lib/clipboard.ts', () => ({ copyText: vi.fn() }))

const preset: ServerPreset = {
  name: 'docker: shop/mysql',
  dialect: 'mysql',
  host: '127.0.0.1',
  port: 13306,
  database: 'shop',
  docker: { service: 'mysql', project: 'shop', privatePort: 3306, user: 'app' },
}

describe('ConnectionInfo', () => {
  beforeEach(() => vi.mocked(copyText).mockReset())

  it('shows nothing for a preset that is not a Docker container', () => {
    const { docker: _, ...operator } = preset
    const { container, rerender } = render(<ConnectionInfo preset={operator} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<ConnectionInfo preset={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the host address first, folded away, with a placeholder for the password', () => {
    const { container } = render(<ConnectionInfo preset={preset} />)
    expect(container.querySelector('details')).not.toHaveAttribute('open')
    expect(screen.getByText('アプリからつなぐときの接続情報')).toBeInTheDocument()
    expect(screen.getByText('127.0.0.1:13306')).toBeInTheDocument()
    expect(screen.getByText('mysql://app:<password>@127.0.0.1:13306/shop')).toBeInTheDocument()
  })

  it('switches to the Compose service address and copies what is shown', async () => {
    vi.mocked(copyText).mockResolvedValue()
    render(<ConnectionInfo preset={preset} />)
    await userEvent.click(screen.getByRole('radio', { name: '同じ compose のコンテナ（shop）' }))
    expect(screen.getByText('mysql:3306')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'DATABASE_URL をコピー' }))
    expect(copyText).toHaveBeenCalledWith('mysql://app:<password>@mysql:3306/shop')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('DATABASE_URL: コピーしました'))
  })

  it('says so when the clipboard refuses', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('denied'))
    render(<ConnectionInfo preset={preset} />)
    await userEvent.click(screen.getByRole('button', { name: '.env（Laravel） をコピー' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('コピーできませんでした'))
  })

  it('offers no same-network address for a container started without Compose', () => {
    render(<ConnectionInfo preset={{ ...preset, docker: { privatePort: 3306 } }} />)
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByText('mysql://<user>:<password>@127.0.0.1:13306/shop')).toBeInTheDocument()
  })
})

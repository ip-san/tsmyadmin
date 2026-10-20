import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RelationDef } from '@tsmyadmin/shared'
import { type ReactNode, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { locale as common } from '@/config/locale.ts'
import { locale } from '@/config/locale-screens.ts'
import { relation } from '@/test/schema-fixtures.ts'
import { type JoinEnds, JoinPath } from './JoinPath.tsx'

const t = locale.joinPath

/** What the mocked API answers, set afresh for each test. */
let names: string[]
let keys: RelationDef[] | Error
/** A reading of the keys held until the test lets it go. */
let hold: Promise<void> | null
let keyReads: number
let tablesFail: boolean

beforeEach(() => {
  // orders → users, orders → products; logs linked to nothing.
  names = ['logs', 'orders', 'products', 'users']
  keys = [relation('orders', ['user_id'], 'users'), relation('orders', ['product_id'], 'products')]
  hold = null
  keyReads = 0
  tablesFail = false
})

vi.mock('@tanstack/react-router', () => ({
  // The address the link goes to, written out: what it carries is what is checked.
  Link: ({ children, to, params, search }: { children: ReactNode; to: string; params: object; search: object }) => (
    <a href={`${to}?${JSON.stringify({ params, search })}`}>{children}</a>
  ),
}))
vi.mock('@/lib/session.ts', () => ({ useDialect: () => 'mysql' }))
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      if (tablesFail) throw new Error('cannot list')
      return [...names.map((name) => ({ name, kind: 'table' })), { name: 'v_orders', kind: 'view' }]
    },
  }),
  foreignKeysQuery: () => ({
    queryKey: ['keys'],
    queryFn: async () => {
      keyReads += 1
      if (hold) await hold
      if (keys instanceof Error) throw keys
      return keys
    },
  }),
}))

/** The card with its two tables kept as the route keeps them, and every change of them recorded. */
function mount(start: JoinEnds = { from: undefined, to: undefined }) {
  const changes: JoinEnds[] = []
  function Kept() {
    const [ends, setEnds] = useState(start)
    return (
      <JoinPath
        db="shop"
        schema={undefined}
        ends={ends}
        onEnds={(next) => {
          changes.push(next)
          setEnds(next)
        }}
      />
    )
  }
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Kept />
    </QueryClientProvider>
  )
  return { ...view, changes }
}
const status = () => screen.getByRole('status')
const choose = (label: string, table: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: table } })
const optionsOf = (label: string) =>
  within(screen.getByLabelText(label))
    .getAllByRole('option')
    .map((o) => o.textContent)

describe('JoinPath', () => {
  it('has an empty status line from the start, and tells the path once both tables are chosen', async () => {
    const { changes } = mount()
    expect(status()).toBeEmptyDOMElement()
    await waitFor(() => expect(optionsOf(t.from)).toEqual([t.choose, 'logs', 'orders', 'products', 'users']))
    choose(t.from, 'users')
    expect(status()).toBeEmptyDOMElement()
    expect(optionsOf(t.to)).toEqual([t.choose, 'logs', 'orders', 'products'])
    choose(t.to, 'products')
    expect(changes).toEqual([
      { from: 'users', to: undefined },
      { from: 'users', to: 'products' },
    ])
    expect(status()).toHaveTextContent(t.found(1, 2, false))
    expect(screen.getByText(t.path(1, ['users', 'orders', 'products']))).toBeInTheDocument()
    expect(
      within(screen.getByRole('list', { name: t.steps(1) }))
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([
      t.hop('users', 'orders', [t.key('orders', 'user_id', 'users', 'id')]),
      t.hop('orders', 'products', [t.key('orders', 'product_id', 'products', 'id')]),
    ])
    // Walked from users: against the key to users (orders refers to it), along the key to products.
    const diagram = screen.getByRole('img', { name: t.diagram('users', 'products') })
    expect([...diagram.querySelectorAll('[data-flow]')].map((p) => p.getAttribute('data-flow'))).toEqual([
      'back',
      'forward',
    ])
    expect(screen.getByRole('link', { name: t.build(1) })).toHaveAttribute(
      'href',
      `/db/$db/query?${JSON.stringify({ params: { db: 'shop' }, search: { tables: ['users', 'orders', 'products'] } })}`
    )
  })

  it('says when no key links the two, and draws nothing', async () => {
    mount({ from: 'logs', to: 'users' })
    await waitFor(() => expect(status()).toHaveTextContent(t.none('logs', 'users')))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('numbers each of several paths, each with its own link, and says when there are more', async () => {
    names = ['a', 'b', 'c', 'd', 'x', 'y']
    keys = ['a', 'b', 'c', 'd'].flatMap((m) => [relation(m, ['x_id'], 'x'), relation(m, ['y_id'], 'y')])
    mount({ from: 'x', to: 'y' })
    await waitFor(() => expect(status()).toHaveTextContent(t.found(3, 2, true)))
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([t.build(1), t.build(2), t.build(3)])
    expect(
      screen.getAllByRole('link').map((a) => JSON.parse(a.getAttribute('href')?.split('?')[1] ?? '').search.tables)
    ).toEqual([
      ['x', 'a', 'y'],
      ['x', 'b', 'y'],
      ['x', 'c', 'y'],
    ])
  })

  it('does not follow a key into another database', async () => {
    keys = [relation('orders', ['user_id'], 'users', { refNamespace: { database: 'elsewhere' } })]
    mount({ from: 'orders', to: 'users' })
    await waitFor(() => expect(status()).toHaveTextContent(t.none('orders', 'users')))
  })

  it('says it is reading the keys while they are read', async () => {
    let release: () => void = () => undefined
    hold = new Promise((r) => {
      release = r
    })
    mount({ from: 'orders', to: 'users' })
    await waitFor(() => expect(status()).toHaveTextContent(t.reading))
    release()
    await waitFor(() => expect(status()).toHaveTextContent(t.found(1, 1, false)))
  })

  it('chooses none of the tables a link names that the database does not have, nor one table twice', async () => {
    mount({ from: 'gone', to: 'users' })
    await waitFor(() => expect(optionsOf(t.from)).toHaveLength(5))
    expect(screen.getByLabelText(t.from)).toHaveValue('')
    expect(screen.getByLabelText(t.to)).toHaveValue('users')
    expect(status()).toBeEmptyDOMElement()
  })

  it('lets the other end go when the table it is is chosen to start from', async () => {
    const { changes } = mount({ from: 'orders', to: 'users' })
    await waitFor(() => expect(status()).toHaveTextContent(t.found(1, 1, false)))
    expect(optionsOf(t.from)).toContain('users')
    choose(t.from, 'users')
    expect(changes).toEqual([{ from: 'users', to: undefined }])
    expect(screen.getByLabelText(t.to)).toHaveValue('')
    expect(status()).toBeEmptyDOMElement()
  })

  it('does not take one table for both ends', async () => {
    mount({ from: 'users', to: 'users' })
    await waitFor(() => expect(screen.getByLabelText(t.from)).toHaveValue('users'))
    expect(screen.getByLabelText(t.to)).toHaveValue('')
    expect(status()).toBeEmptyDOMElement()
  })

  it('leaves the error of the table list to the map, which reads the same list', async () => {
    names = []
    tablesFail = true
    mount({ from: 'orders', to: 'users' })
    await waitFor(() => expect(keyReads).toBe(1))
    await waitFor(() => expect(screen.getByLabelText(t.from)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: common.common.retry })).not.toBeInTheDocument()
  })

  it('shows nothing for a database of fewer than two tables (views are not counted)', async () => {
    names = ['users']
    const { container } = mount()
    await waitFor(() => expect(keyReads).toBe(1))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('says why when the keys cannot be read, reads them again, and does not say the two are not linked', async () => {
    keys = new Error('cannot read')
    mount({ from: 'orders', to: 'users' })
    await waitFor(() => expect(screen.getByText('cannot read')).toBeInTheDocument())
    expect(status()).toBeEmptyDOMElement()
    keys = [relation('orders', ['user_id'], 'users')]
    fireEvent.click(screen.getByRole('button', { name: common.common.retry }))
    await waitFor(() => expect(status()).toHaveTextContent(t.found(1, 1, false)))
    expect(keyReads).toBe(2)
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Dialect, TableSchema } from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { locale as common } from '@/config/locale.ts'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, from, table } from '@/test/schema-fixtures.ts'
import { DatabaseMap } from './DatabaseMap.tsx'

const t = locale.databaseMap

/** What the mocked API answers, set afresh for each test. */
let dialect: Dialect
let listed: { name: string; kind: TableSchema['kind'] }[] | Error
let schemas: Record<string, TableSchema>
let failing: Set<string>
let reads: string[]
/** A reading held until the test lets it go, to look at the page while it reads. */
let hold: Promise<void> | null

/** users ← orders (a key without an index), and logs without a primary key; a sequence the map leaves out. */
function shop() {
  schemas = {
    users: table('users', { referencedBy: [from('orders')] }),
    orders: table('orders', { foreignKeys: [fk(['user_id'], 'users')] }),
    logs: table('logs', { primaryKey: [] }),
  }
  listed = [
    ...Object.keys(schemas).map((name) => ({ name, kind: 'table' as const })),
    { name: 'seq', kind: 'sequence' },
  ]
}

beforeEach(() => {
  dialect = 'mysql'
  failing = new Set()
  reads = []
  hold = null
  shop()
})

vi.mock('@tanstack/react-router', () => ({
  // The address the link goes to, written out: what it carries is what is checked.
  Link: ({ children, to, params, search }: { children: ReactNode; to: string; params: object; search: object }) => (
    <a href={`${to}?${JSON.stringify({ params, search })}`}>{children}</a>
  ),
}))
// Counts the readings of all the definitions: a second press must join the one under way, not start another.
const readings = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/lib/each-limited.ts', async (actual) => {
  const real = await actual<typeof import('@/lib/each-limited.ts')>()
  return {
    eachLimited: (...args: Parameters<typeof real.eachLimited>) => {
      readings.count += 1
      return real.eachLimited(...args)
    },
  }
})
vi.mock('@/lib/session.ts', () => ({ useDialect: () => dialect }))
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      if (listed instanceof Error) throw listed
      return listed
    },
  }),
  structureQuery: ({ table: name }: { table: string }) => ({
    queryKey: ['structure', name],
    queryFn: async () => {
      reads.push(name)
      if (hold) await hold
      if (failing.has(name)) throw new Error('cannot read')
      return schemas[name]
    },
  }),
}))

const mount = (schema?: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DatabaseMap db="shop" schema={schema} />
    </QueryClientProvider>
  )
const status = () => screen.getByRole('status')
const saysAtLast = (text: string) => waitFor(() => expect(status()).toHaveTextContent(text))
const address = (to: string, params: object, search: object) => `${to}?${JSON.stringify({ params, search })}`

describe('DatabaseMap', () => {
  it('says what it is reading on the one status line there from the start', async () => {
    mount()
    expect(status()).toHaveTextContent(t.reading)
    await saysAtLast(t.summary(3, 0))
    // That alone: no tables to name as failed, nothing being read.
    expect(status().textContent).toBe(t.summary(3, 0))
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: t.title('shop') })).toBeInTheDocument()
  })

  it('sorts the tables by role, each linked to its overview, and lists no role no table has', async () => {
    mount()
    const masters = await screen.findByRole('list', { name: t.roles.master })
    expect(within(masters).getByRole('link', { name: 'users' })).toHaveAttribute(
      'href',
      address('/db/$db/table/$table/overview', { db: 'shop', table: 'users' }, {})
    )
    expect(within(screen.getByRole('list', { name: t.roles.detail })).getByRole('link')).toHaveTextContent('orders')
    expect(screen.queryByRole('list', { name: t.roles.junction })).toBeNull()
  })

  it('names the tables most referred to and what to look at, a key without an index linked to the structure', async () => {
    mount('sales')
    const hubs = await screen.findByRole('list', { name: t.hubsTitle })
    // The schema named, not the database.
    expect(screen.getByRole('heading', { name: t.title('sales') })).toBeInTheDocument()
    expect(within(hubs).getByRole('listitem')).toHaveTextContent(`users ${t.hub(1)}`)
    expect(within(hubs).getByRole('link', { name: 'users' })).toHaveAttribute(
      'href',
      address('/db/$db/table/$table/overview', { db: 'shop', table: 'users' }, { schema: 'sales' })
    )
    const keyless = screen.getByRole('region', { name: t.noPrimaryKey })
    expect(within(keyless).getByRole('link')).toHaveTextContent('logs')
    const unindexed = screen.getByRole('region', { name: t.unindexed })
    expect(within(unindexed).getByRole('link', { name: t.unindexedKey('orders', 'user_id', 'users') })).toHaveAttribute(
      'href',
      address('/db/$db/table/$table/structure', { db: 'shop', table: 'orders' }, { schema: 'sales' })
    )
  })

  it('says there is none of each when every table was read and nothing is there', async () => {
    schemas = { a: table('a'), b: table('b') }
    listed = [
      { name: 'a', kind: 'table' },
      { name: 'b', kind: 'table' },
    ]
    mount()
    expect(await screen.findByText(t.hubsNone)).toBeInTheDocument()
    expect(screen.getByText(t.noPrimaryKeyNone)).toBeInTheDocument()
    expect(screen.getByText(t.unindexedNone)).toBeInTheDocument()
    expect(screen.getByText(t.keyTypesNone)).toBeInTheDocument()
    expect(screen.getByText(t.nameTypesNone)).toBeInTheDocument()
  })

  it('names a key of another kind of type or collation than what it refers to, and an _id name of two types', async () => {
    schemas = {
      users: table('users', {
        columns: [column('id', 'int'), column('code', 'varchar(8)', { collation: 'utf8mb4_bin' }), column('n', 'int')],
      }),
      orders: table('orders', {
        columns: [
          column('user_id', 'decimal(10,0)'),
          column('user_code', 'varchar(8)', { collation: 'utf8mb4_general_ci' }),
          column('n_id', 'bigint'),
        ],
        foreignKeys: [
          fk(['user_id'], 'users'),
          fk(['user_code'], 'users', { name: 'fk_code', refColumns: ['code'] }),
          // A bigint referring to an int: one kind, compared as it is; not listed.
          fk(['n_id'], 'users', { name: 'fk_n', refColumns: ['n'] }),
        ],
      }),
      logs: table('logs', { columns: [column('user_id', 'int')] }),
    }
    listed = Object.keys(schemas).map((name) => ({ name, kind: 'table' }))
    mount()
    const keys = await screen.findByRole('region', { name: t.keyTypes })
    expect(
      within(keys)
        .getAllByRole('link')
        .map((a) => a.textContent)
    ).toEqual([
      t.keyType(t.keySide('orders', 'user_id', 'decimal(10,0)', null), t.keySide('users', 'id', 'int', null)),
      // The collations in the sentence (and the link's name), each on its side.
      t.keyType(
        t.keySide('orders', 'user_code', 'varchar(8)', 'utf8mb4_general_ci'),
        t.keySide('users', 'code', 'varchar(8)', 'utf8mb4_bin')
      ),
    ])
    expect(within(keys).getAllByRole('link')[0]).toHaveAttribute(
      'href',
      address('/db/$db/table/$table/structure', { db: 'shop', table: 'orders' }, {})
    )
    const types = within(screen.getByRole('region', { name: t.nameTypes })).getByRole('list', {
      name: t.nameTypesOf('user_id'),
    })
    expect(
      within(types)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([t.nameType('decimal', ['orders']), t.nameType('int', ['logs'])])
  })

  it('says which tables could not be read and says "none" of nothing while they are missing', async () => {
    // What was read (logs) has no hub and no foreign key: what was not may have.
    failing = new Set(['users', 'orders'])
    mount()
    await saysAtLast(t.sentences([t.summary(1, 0), t.failed(['users', 'orders'], 0)]))
    expect(screen.queryByText(t.hubsNone)).toBeNull()
    expect(screen.queryByText(t.unindexedNone)).toBeNull()
    expect(screen.queryByText(t.keyTypesNone)).toBeNull()
    expect(screen.queryByText(t.nameTypesNone)).toBeNull()
    expect(screen.getByRole('list', { name: t.roles.isolated })).toHaveTextContent('logs')
  })

  it('names five of the tables that could not be read, and counts the rest', async () => {
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7']
    schemas = {}
    listed = names.map((name) => ({ name, kind: 'table' }))
    failing = new Set(names)
    mount()
    await saysAtLast(t.failed(names.slice(0, 5), 2))
  })

  it('reads the tables that failed again once, however quickly it is pressed twice', async () => {
    failing = new Set(['logs'])
    mount()
    const again = await screen.findByRole('button', { name: t.readAgain })
    failing = new Set()
    reads = []
    readings.count = 0
    let release: () => void = () => undefined
    hold = new Promise((resolve) => {
      release = resolve
    })
    fireEvent.click(again)
    fireEvent.click(again)
    // Said while it reads, the map read before kept.
    await saysAtLast(t.reading)
    expect(screen.getByRole('list', { name: t.roles.master })).toBeInTheDocument()
    fireEvent.click(again)
    release()
    await waitFor(() => expect(status()).not.toHaveTextContent(t.reading))
    expect(status()).toHaveTextContent(t.summary(3, 0))
    expect(readings.count).toBe(1)
    expect(reads).toEqual(['logs'])
    expect(screen.queryByRole('button', { name: t.readAgain })).toBeNull()
  })

  it('says there is nothing when the database has no tables or views (a sequence is not one)', async () => {
    listed = [{ name: 'seq', kind: 'sequence' }]
    mount()
    await saysAtLast(t.empty)
    expect(screen.queryByRole('list')).toBeNull()
    expect(reads).toEqual([])
  })

  it('counts the views of a database of views only, with no lists', async () => {
    schemas = { v: table('v', { kind: 'view', primaryKey: [] }) }
    listed = [{ name: 'v', kind: 'view' }]
    mount()
    await saysAtLast(t.summary(0, 1))
    expect(screen.queryByRole('region', { name: t.noPrimaryKey })).toBeNull()
  })

  it('shows why the list of tables could not be read, and reads it again when asked', async () => {
    listed = new Error('no list')
    mount()
    expect(await screen.findByText(/no list/)).toBeInTheDocument()
    expect(status()).toBeEmptyDOMElement()
    shop()
    fireEvent.click(screen.getByRole('button', { name: common.common.retry }))
    await saysAtLast(t.summary(3, 0))
  })

  it('on PostgreSQL with no schema named, takes public for home, and another schema for elsewhere', async () => {
    dialect = 'postgres'
    const pub = { database: 'shop', schema: 'public' }
    const audit = { database: 'shop', schema: 'audit' }
    schemas = {
      users: table('users', { referencedBy: [from('orders', { fromNamespace: pub })] }),
      orders: table('orders', { foreignKeys: [fk(['user_id'], 'users', { refNamespace: pub })] }),
      // A key to audit.history from public.history: a key to another table, not a tree.
      history: table('history', { foreignKeys: [fk(['id'], 'history', { refNamespace: audit })] }),
    }
    listed = Object.keys(schemas).map((name) => ({ name, kind: 'table' }))
    mount()
    expect(await screen.findByRole('list', { name: t.roles.master })).toHaveTextContent('users')
    const details = within(screen.getByRole('list', { name: t.roles.detail }))
    expect(details.getAllByRole('link').map((a) => a.textContent)).toEqual(['history', 'orders'])
    expect(screen.queryByRole('list', { name: t.roles.tree })).toBeNull()
  })
})

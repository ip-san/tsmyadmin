import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TableSchema } from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { DatabaseMap } from './DatabaseMap.tsx'

const t = locale.databaseMap
let failing = new Set<string>()

const table = (name: string, over: Partial<TableSchema> = {}): TableSchema => ({
  name,
  kind: 'table',
  comment: null,
  engine: null,
  rowEstimate: null,
  partitioned: false,
  hasChildren: false,
  inherits: [],
  collation: null,
  autoIncrement: null,
  columns: [],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  ...over,
})
const schemas: Record<string, TableSchema> = {
  users: table('users', {
    referencedBy: [
      {
        name: 'fk',
        fromNamespace: { database: 'shop' },
        fromTable: 'orders',
        fromColumns: ['user_id'],
        columns: ['id'],
      },
    ],
  }),
  orders: table('orders', {
    foreignKeys: [
      {
        name: 'fk',
        columns: ['user_id'],
        refNamespace: { database: 'shop' },
        refTable: 'users',
        refColumns: ['id'],
        onUpdate: null,
        onDelete: null,
      },
    ],
  }),
  logs: table('logs', { primaryKey: [] }),
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: ReactNode; to: string; params: object }) => (
    <a href={`${to}?${JSON.stringify(params)}`}>{children}</a>
  ),
}))
vi.mock('@/lib/session.ts', () => ({ useDialect: () => 'mysql' }))
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => [
      ...Object.keys(schemas).map((name) => ({ name, kind: 'table' })),
      { name: 'seq', kind: 'sequence' },
    ],
  }),
  structureQuery: ({ table: name }: { table: string }) => ({
    queryKey: ['structure', name],
    queryFn: async () => {
      if (failing.has(name)) throw new Error('cannot read')
      return schemas[name]
    },
  }),
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DatabaseMap db="shop" schema={undefined} />
    </QueryClientProvider>
  )

describe('DatabaseMap', () => {
  it('says what it is reading on the one status line there from the start', async () => {
    mount()
    expect(screen.getByRole('status')).toHaveTextContent(t.reading)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.summary(3, 0)))
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('says how many tables there are, by role, with each linked to its overview', async () => {
    mount()
    expect(await screen.findByText(t.summary(3, 0))).toHaveAttribute('role', 'status')
    const masters = screen.getByRole('list', { name: t.roles.master })
    const users = within(masters).getByRole('link', { name: 'users' })
    expect(users.getAttribute('href')).toContain('/overview?')
    expect(within(screen.getByRole('list', { name: t.roles.detail })).getByText('orders')).toBeInTheDocument()
    // A role no table has is not listed.
    expect(screen.queryByRole('list', { name: t.roles.junction })).toBeNull()
  })

  it('names the tables most referred to, and what to look at', async () => {
    mount()
    const hubs = await screen.findByRole('list', { name: t.hubsTitle })
    expect(within(hubs).getByText(t.hub(1))).toBeInTheDocument()
    const keyless = screen.getByRole('region', { name: t.noPrimaryKey })
    expect(within(keyless).getByRole('link', { name: 'logs' })).toBeInTheDocument()
    const unindexed = screen.getByRole('region', { name: t.unindexed })
    expect(
      within(unindexed).getByRole('link', { name: t.unindexedKey('orders', 'user_id', 'users') })
    ).toBeInTheDocument()
  })

  it('says which tables could not be read, offers to read them again, and does not say "none"', async () => {
    failing = new Set(['logs'])
    try {
      mount()
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(t.sentences([t.summary(2, 0), t.failed(['logs'], 0)]))
      )
      expect(screen.getByRole('button', { name: t.readAgain })).toBeInTheDocument()
      // logs may have no primary key, or a key without an index: not said that there are none.
      expect(screen.queryByText(t.noPrimaryKeyNone)).toBeNull()
      expect(screen.getByRole('button', { name: t.readAgain })).not.toHaveAttribute('aria-disabled', 'true')
    } finally {
      failing = new Set()
    }
  })

  it('says none of the other lists are empty while tables are missing, and reads them again when asked', async () => {
    failing = new Set(['users', 'orders'])
    try {
      mount()
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.summary(1, 0)))
      // What was read has no hub and no foreign key: what was not may have.
      expect(screen.queryByText(t.hubsNone)).toBeNull()
      expect(screen.queryByText(t.unindexedNone)).toBeNull()
      failing = new Set()
      fireEvent.click(screen.getByRole('button', { name: t.readAgain }))
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.summary(3, 0)))
      expect(screen.queryByRole('button', { name: t.readAgain })).toBeNull()
    } finally {
      failing = new Set()
    }
  })

  it('says "none" when every table was read and nothing is there', async () => {
    const saved = schemas.logs
    schemas.logs = table('logs')
    try {
      mount()
      expect(await screen.findByText(t.noPrimaryKeyNone)).toBeInTheDocument()
    } finally {
      schemas.logs = saved as TableSchema
    }
  })
})

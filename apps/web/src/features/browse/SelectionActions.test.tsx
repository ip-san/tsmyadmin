import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowseResult } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { SelectionActions } from './SelectionActions.tsx'

// The edit dialog is always mounted (closed) and reads the session: not what is tested here.
vi.mock('./RowDialogs.tsx', () => ({ EditRowsDialog: () => null }))
vi.mock('./RowGraphDialog.tsx', () => ({
  RowGraphDialog: ({ root }: { root: { id: string } }) => <p>graph of {root.id}</p>,
}))

const page = (keys: Partial<Pick<BrowseResult, 'foreignKeys' | 'referencedBy'>>): BrowseResult => ({
  columns: [
    { name: 'id', dataType: 'int' },
    { name: 'user_id', dataType: 'int' },
  ],
  rows: [
    [1, 10],
    [2, 20],
  ],
  truncated: false,
  total: 2,
  count: 'exact',
  keyKind: 'pk',
  keyColumns: ['id'],
  foreignKeys: [],
  referencedBy: [],
  statement: { sql: 'SELECT', params: [], literal: 'SELECT', durationMs: 1 },
  ...keys,
})
const fk = {
  name: 'fk',
  columns: ['user_id'],
  refNamespace: { database: 'shop' },
  refTable: 'users',
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
}

const show = (data: BrowseResult, selected: number[]) =>
  render(
    <SelectionActions
      tableRef={{ db: 'shop', table: 'posts' }}
      data={data}
      selected={new Set(selected)}
      keys={[null, null]}
      editable={false}
      onDone={vi.fn()}
    />
  )

const follow = () => screen.queryByRole('button', { name: locale.rowGraph.open })

describe('SelectionActions: following a row', () => {
  it('offers it for one ticked row of a table a key joins to another, and opens that row', async () => {
    show(page({ foreignKeys: [fk] }), [1])
    await userEvent.click(follow() as HTMLElement)
    expect(await screen.findByText(`graph of ${JSON.stringify(['shop', '', 'posts', [2]])}`)).toBeInTheDocument()
  })

  it('offers it for a table only referred to, too', () => {
    const referred = {
      name: 'fk',
      fromNamespace: { database: 'shop' },
      fromTable: 'c',
      fromColumns: ['p'],
      columns: ['id'],
    }
    show(page({ referencedBy: [referred] }), [0])
    expect(follow()).not.toBeNull()
  })

  it('does not offer it for two rows', () => {
    show(page({ foreignKeys: [fk] }), [0, 1])
    expect(follow()).toBeNull()
  })

  it('does not offer it for a table without keys to follow', () => {
    show(page({}), [0])
    expect(follow()).toBeNull()
  })
})

import { render, screen } from '@testing-library/react'
import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { overlayUpTo } from './overlay.ts'
import { relationKey, SchemaDiagram } from './SchemaDiagram.tsx'

const key: RelationDef = {
  table: 'orders',
  name: 'fk_orders_user',
  columns: ['user_id'],
  refNamespace: { database: 'app' },
  refTable: 'users',
  refColumns: ['id'],
  onUpdate: null,
  onDelete: 'CASCADE',
}
const props = {
  tables: ['users', 'orders', 'logs'],
  relations: [key],
  columns: new Map([
    ['users', ['id']],
    ['orders', ['user_id']],
    ['logs', []],
  ]),
  positions: { users: { x: 0, y: 0 }, orders: { x: 300, y: 0 }, logs: { x: 0, y: 200 } },
}

describe('SchemaDiagram', () => {
  it('is one image, not a field of buttons, when nothing can be moved', () => {
    render(<SchemaDiagram {...props} label="Delete impact" />)
    expect(screen.getByRole('img', { name: 'Delete impact' })).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('keeps its boxes as buttons when they can be moved', () => {
    render(<SchemaDiagram {...props} onMove={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('lights what the overlay names, with its badge, and fades the rest', () => {
    const overlay = overlayUpTo(
      [
        {
          text: '',
          tables: [{ name: 'orders', tone: 'delete', badge: '12' }],
          relations: [{ key: relationKey(key), tone: 'delete' }],
          columns: [{ table: 'orders', column: 'user_id' }],
        },
      ],
      0
    )
    const { container } = render(<SchemaDiagram {...props} overlay={overlay} />)
    const toned = [...container.querySelectorAll('[data-tone="delete"]')]
    expect(toned).toHaveLength(2)
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('user_id')).toHaveClass('font-semibold')
    const faded = [...container.querySelectorAll('g.opacity-30')]
    expect(faded).toHaveLength(2)
  })

  it('fades nothing without an overlay', () => {
    const { container } = render(<SchemaDiagram {...props} />)
    expect(container.querySelectorAll('.opacity-30')).toHaveLength(0)
  })
})

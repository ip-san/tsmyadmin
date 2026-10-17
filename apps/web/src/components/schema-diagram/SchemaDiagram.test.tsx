import { render, screen } from '@testing-library/react'
import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { relationKey } from './layout.ts'
import { overlayUpTo } from './overlay.ts'
import { SchemaDiagram } from './SchemaDiagram.tsx'

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

  it('lights and fades boxes that can be moved as well', () => {
    const overlay = overlayUpTo([{ text: '', tables: [{ name: 'orders', tone: 'scan', badge: 'full 9' }] }], 0)
    const { container } = render(<SchemaDiagram {...props} onMove={vi.fn()} overlay={overlay} />)
    expect(screen.getByRole('button', { name: /orders/ })).toHaveAttribute('data-tone', 'scan')
    expect(screen.getByRole('button', { name: /users/ })).toHaveClass('opacity-30')
    // The badge is in the box's name too: it is drawn as text a screen reader does not reach inside a button.
    expect(
      screen.getByRole('button', { name: locale.designer.boxLabelWithBadge('orders', 'full 9') })
    ).toBeInTheDocument()
    expect(container.querySelectorAll('[data-tone="scan"]')).toHaveLength(1)
  })

  it('badges a line at its middle without its label shown, and fades nothing when the overlay only adds', () => {
    const overlay = {
      tables: new Map(),
      relations: new Map([[relationKey(key), 'delete' as const]]),
      columns: new Map(),
      relationBadges: new Map([[relationKey(key), 'no parent: 3']]),
      fade: false,
    }
    const { container } = render(<SchemaDiagram {...props} overlay={overlay} />)
    expect(screen.getByText('no parent: 3')).toBeInTheDocument()
    expect(container.querySelector('[data-tone="delete"]')).not.toBeNull()
    expect(container.querySelectorAll('.opacity-30')).toHaveLength(0)
  })
})

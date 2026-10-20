import { render, screen } from '@testing-library/react'
import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { DEFAULT_VIEW, relationKey } from './layout.ts'
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

  it('writes the comment of a table under its box, and in its name, only when asked', () => {
    const notes = new Map([['users', '会員の一覧']])
    const { rerender } = render(<SchemaDiagram {...props} onMove={vi.fn()} notes={notes} />)
    expect(screen.queryByText('会員の一覧')).toBeNull()
    rerender(<SchemaDiagram {...props} onMove={vi.fn()} notes={notes} view={{ ...DEFAULT_VIEW, comments: true }} />)
    expect(screen.getAllByText('会員の一覧').length).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: locale.designer.withNote(locale.designer.boxLabel('users'), '会員の一覧') })
    ).toBeInTheDocument()
  })

  it('says more about the box selected where asked, under its names', async () => {
    render(
      <SchemaDiagram {...props} onMove={vi.fn()} selectedMore={(table) => <a href="#x">{`more on ${table}`}</a>} />
    )
    screen.getByRole('button', { name: locale.designer.boxLabel('users') }).focus()
    expect(await screen.findByRole('link', { name: 'more on users' })).toBeInTheDocument()
  })

  it('shows the part a camera frames, scaled to fill its frame, which then does not scroll', () => {
    const { container } = render(
      <SchemaDiagram {...props} label="Tour" camera={{ x: 10, y: 20, width: 300, height: 200 }} />
    )
    const svg = screen.getByRole('img', { name: 'Tour' })
    expect(svg).toHaveAttribute('viewBox', '10 20 300 200')
    expect(svg).toHaveAttribute('width', '100%')
    expect(container.querySelector('figure')).not.toHaveAttribute('tabindex')
    expect(container.querySelector('figure')).toHaveClass('overflow-hidden')
  })

  it('draws a flowing line over each key the overlay lets flow, either way', () => {
    const other: RelationDef = { ...key, name: 'fk_other', table: 'logs' }
    const { container } = render(
      <SchemaDiagram
        {...props}
        relations={[key, other]}
        overlay={{
          tables: new Map(),
          relations: new Map(),
          columns: new Map(),
          flow: new Map([
            [relationKey(key), 'forward'],
            [relationKey(other), 'back'],
          ]),
        }}
      />
    )
    const flows = [...container.querySelectorAll('[data-flow]')]
    expect(flows.map((f) => f.getAttribute('data-flow'))).toEqual(['forward', 'back'])
    expect(flows[0]).not.toHaveClass('diagram-flow-back')
    expect(flows[1]).toHaveClass('diagram-flow', 'diagram-flow-back')
  })

  it('brings the boxes in column by column, then draws the lines, when the overlay enters', () => {
    const { container } = render(
      <SchemaDiagram
        {...props}
        overlay={{ tables: new Map(), relations: new Map(), columns: new Map(), fade: false, enter: true }}
      />
    )
    const boxes = [...container.querySelectorAll<SVGGElement>('.diagram-enter')]
    // users and logs in the first column, orders in the second.
    expect(boxes.map((b) => b.style.animationDelay)).toEqual(['0ms', '120ms', '0ms'])
    const line = container.querySelector<SVGPathElement>('.diagram-draw')
    expect(line).toHaveAttribute('pathLength', '1')
    expect(line?.style.animationDelay).toBe('240ms')
  })

  it('neither enters nor flows without an overlay that asks', () => {
    const { container } = render(<SchemaDiagram {...props} />)
    expect(container.querySelector('.diagram-enter, .diagram-draw, [data-flow]')).toBeNull()
  })

  it('draws what it is given over the diagram', () => {
    const { container } = render(<SchemaDiagram {...props} over={<circle data-testid="over" />} />)
    expect(container.querySelector('svg > [data-testid="over"]')).not.toBeNull()
  })
})

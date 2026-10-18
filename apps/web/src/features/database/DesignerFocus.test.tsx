import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { useDesignerFocus } from './DesignerFocus.tsx'

const t = locale.designer.focus
const key = (table: string, refTable: string) => ({ table, refTable, name: `fk_${table}` }) as RelationDef
const shape = {
  tables: ['users', 'orders', 'items', 'logs'],
  relations: [key('orders', 'users'), key('items', 'orders')],
}

/** The hook's control and notice, with what it would draw and where. */
function Harness({ focus, hops = 1, onChange = vi.fn() }: { focus?: string; hops?: number; onChange?: () => void }) {
  const f = useDesignerFocus({ focus, hops, names: shape.tables, onChange })
  const drawn = f.apply(shape)
  const positions = f.positions({ users: { x: 0, y: 0 } }, { users: { x: 500, y: 500 } })
  return (
    <div>
      {f.control}
      {f.notice(drawn.tables.length, shape.tables.length)}
      <p data-testid="drawn">{drawn.tables.join(',')}</p>
      <p data-testid="keys">{drawn.relations.map((r) => r.table).join(',')}</p>
      <p data-testid="at">{JSON.stringify(positions.users)}</p>
      <button type="button" onClick={() => f.move('users', { x: 7, y: 7 }, true, vi.fn())}>
        move
      </button>
    </div>
  )
}

describe('useDesignerFocus', () => {
  it('draws every table where they were saved, without a focus', () => {
    render(<Harness />)
    expect(screen.getByTestId('drawn')).toHaveTextContent('users,orders,items,logs')
    expect(screen.getByTestId('at')).toHaveTextContent('{"x":500,"y":500}')
    expect(screen.getByLabelText(t.hops)).toBeDisabled()
  })

  it('draws the tables around the focus, laid out on their own, and says how many', () => {
    render(<Harness focus="orders" />)
    expect(screen.getByTestId('drawn')).toHaveTextContent('users,orders,items')
    expect(screen.getByTestId('keys')).toHaveTextContent('orders,items')
    // The saved place is the whole database's: not used for a focused diagram.
    expect(screen.getByTestId('at')).toHaveTextContent('{"x":0,"y":0}')
    expect(screen.getByText(t.showing('orders', 1, 3, 4))).toBeInTheDocument()
  })

  it('keeps a box moved while focused for that focus only, without saving it', async () => {
    const save = vi.fn()
    function Moves({ focus }: { focus: string }) {
      const f = useDesignerFocus({ focus, hops: 1, names: shape.tables, onChange: vi.fn() })
      return (
        <>
          <p data-testid="at">{JSON.stringify(f.positions({ users: { x: 0, y: 0 } }, {}).users)}</p>
          <button type="button" onClick={() => f.move('users', { x: 7, y: 7 }, true, save)}>
            move
          </button>
        </>
      )
    }
    const { rerender } = render(<Moves focus="orders" />)
    await userEvent.click(screen.getByRole('button', { name: 'move' }))
    expect(screen.getByTestId('at')).toHaveTextContent('{"x":7,"y":7}')
    expect(save).not.toHaveBeenCalled()
    rerender(<Moves focus="users" />)
    expect(screen.getByTestId('at')).toHaveTextContent('{"x":0,"y":0}')
  })

  it('says a focus that is not a table, and draws everything', () => {
    render(<Harness focus="gone" />)
    expect(screen.getByText(t.missing('gone'))).toBeInTheDocument()
    expect(screen.getByTestId('drawn')).toHaveTextContent('users,orders,items,logs')
  })

  it('asks for a focus and a reach when they are chosen, and none for "all"', async () => {
    const onChange = vi.fn()
    render(<Harness focus="orders" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText(t.hops), '2')
    expect(onChange).toHaveBeenLastCalledWith('orders', 2)
    await userEvent.selectOptions(screen.getByLabelText(t.around), t.all)
    expect(onChange).toHaveBeenLastCalledWith(undefined, 1)
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { TRIED_INDEX_COMMENT } from '@tsmyadmin/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { column, index, table } from '@/test/schema-fixtures.ts'
import { type IndexDialog, IndexesCard } from './IndexesCard.tsx'

const logs = table('logs', {
  columns: [column('id', 'int'), column('level', 'int')],
  indexes: [index(['id'], { name: 'logs_pkey', primary: true, unique: true })],
  unusableIndexes: ['idx_logs_level'],
})

function mount(editable: boolean, onPreview = vi.fn()) {
  render(
    <IndexesCard
      schema={logs}
      dialect="postgres"
      editable={editable}
      dialog={null}
      onDialog={() => undefined}
      onPreview={onPreview}
    />
  )
  return onPreview
}

describe('IndexesCard: indexes a build left unusable', () => {
  it('names them apart from the indexes, and drops one without stopping writes through the preview', () => {
    const onPreview = mount(true)
    const left = screen.getByRole('region', { name: locale.table.unusableIndexes })
    expect(left.textContent).toContain(locale.table.unusableIndexesNote)
    expect(within(screen.getByRole('table', { name: locale.table.indexes })).queryByText('idx_logs_level')).toBeNull()
    fireEvent.click(within(left).getByRole('button', { name: locale.ddl.index.dropOf('idx_logs_level') }))
    expect(onPreview).toHaveBeenCalledWith({ op: 'dropIndex', table: 'logs', name: 'idx_logs_level', online: true })
  })

  it('says so read-only, with nothing to press', () => {
    mount(false)
    const left = screen.getByRole('region', { name: locale.table.unusableIndexes })
    expect(left.textContent).toContain('idx_logs_level')
    expect(within(left).queryByRole('button')).toBeNull()
  })
})

describe('IndexesCard: building a new index without stopping writes', () => {
  const t = locale.ddl.index
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  })
  function open(dialog: IndexDialog, schema = logs) {
    const onPreview = vi.fn()
    render(
      <IndexesCard
        schema={schema}
        dialect="postgres"
        editable
        dialog={dialog}
        onDialog={() => undefined}
        onPreview={onPreview}
      />
    )
    return onPreview
  }

  it('offers it for a new index, off by default, and sends it only when ticked', () => {
    const onPreview = open({ mode: 'add', initial: { columns: ['level'] } })
    const box = screen.getByRole('checkbox', { name: t.online })
    expect((box as HTMLInputElement).checked).toBe(false)
    expect(box.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: locale.ddl.submit }))
    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'addIndex', table: 'logs', columns: ['level'], online: true })
    )
  })

  it('leaves it out of a plain build', () => {
    const onPreview = open({ mode: 'add', initial: { columns: ['level'] } })
    fireEvent.click(screen.getByRole('button', { name: locale.ddl.submit }))
    expect(onPreview.mock.lastCall?.[0]).not.toHaveProperty('online')
  })

  it('does not offer it when changing an index', () => {
    open({ mode: 'edit', index: index(['level'], { name: 'idx_logs_level' }) })
    expect(screen.queryByRole('checkbox', { name: t.online })).toBeNull()
  })

  it('keeps the comment of an index changed, so one tried from a plan stays told apart', () => {
    const tried = index(['level'], { name: 'idx_logs_level', comment: TRIED_INDEX_COMMENT })
    const onPreview = open({ mode: 'edit', index: tried })
    fireEvent.click(screen.getByRole('button', { name: locale.ddl.submit }))
    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'alterIndex',
        name: 'idx_logs_level',
        index: expect.objectContaining({ comment: TRIED_INDEX_COMMENT }),
      })
    )
  })

  it('does not offer it on a partitioned parent, which cannot build one so', () => {
    open({ mode: 'add', initial: { columns: ['level'] } }, { ...logs, partitioned: true })
    expect(screen.queryByRole('checkbox', { name: t.online })).toBeNull()
  })
})

describe('IndexesCard: comments', () => {
  it('tells an index tried from a plan apart, and shows any other comment as it is', () => {
    render(
      <IndexesCard
        schema={table('logs', {
          columns: [column('id', 'int'), column('level', 'int')],
          indexes: [
            index(['level'], { name: 'idx_logs_level', comment: TRIED_INDEX_COMMENT }),
            index(['id'], { name: 'by_id', comment: 'for the nightly report' }),
            index(['id', 'level'], { name: 'plain' }),
          ],
        })}
        dialect="mysql"
        editable={false}
        dialog={null}
        onDialog={() => undefined}
        onPreview={() => undefined}
      />
    )
    const rows = within(screen.getByRole('table', { name: locale.table.indexes })).getAllByRole('row')
    const row = (name: string) => rows.find((r) => r.textContent?.startsWith(name))?.textContent ?? ''
    expect(row('idx_logs_level')).toContain(locale.table.triedIndex)
    expect(row('idx_logs_level')).not.toContain(TRIED_INDEX_COMMENT)
    expect(row('by_id')).toContain('for the nightly report')
    expect(row('by_id')).not.toContain(locale.table.triedIndex)
    expect(row('plain')).not.toContain(locale.table.triedIndex)
  })
})

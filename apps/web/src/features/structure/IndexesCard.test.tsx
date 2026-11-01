import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { column, index, table } from '@/test/schema-fixtures.ts'
import { IndexesCard } from './IndexesCard.tsx'

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

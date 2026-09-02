import type { BrowseResult, Cell, RowKey } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { memo } from 'react'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Td, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { CellEditor } from './CellEditor.tsx'
import { FkCell } from './FkCell.tsx'
import type { linkableForeignKeys, linkableReverseKeys } from './fk-links.ts'
import { RowActions } from './RowActions.tsx'

export interface BrowseRowProps {
  index: number
  row: Cell[]
  rowKey: RowKey | null
  columns: BrowseResult['columns']
  columnIndex: Map<string, number>
  fks: ReturnType<typeof linkableForeignKeys>
  reverse: ReturnType<typeof linkableReverseKeys>
  db: string
  editable: boolean
  selected: boolean
  /** Column index of the cell being edited inline in this row, or -1. */
  inlineCol: number
  updatePending: boolean
  updateError: unknown
  onToggle: (index: number) => void
  onEdit: (index: number) => void
  onCopy: (index: number) => void
  onInline: (index: number, col: number) => void
  onInlineSave: (key: RowKey, column: string, value: Cell) => void
  onInlineCancel: () => void
}

/**
 * One browse row. Memoised with index-based callbacks so a checkbox toggle or an inline edit re-renders only the
 * rows whose props changed, not every cell of a 1,000-row page.
 */
export const BrowseRow = memo(function BrowseRow({
  index: i,
  row,
  rowKey: key,
  columns,
  columnIndex,
  fks,
  reverse,
  db,
  editable,
  selected,
  inlineCol,
  updatePending,
  updateError,
  onToggle,
  onEdit,
  onCopy,
  onInline,
  onInlineSave,
  onInlineCancel,
}: BrowseRowProps) {
  return (
    <Tr className={cn(selected && 'bg-blue-50 dark:bg-blue-950/40')}>
      {editable ? (
        <RowActions
          index={i}
          addressable={key !== null}
          selected={selected}
          onToggle={() => onToggle(i)}
          onEdit={() => onEdit(i)}
          onCopy={() => onCopy(i)}
        />
      ) : null}
      {columns.map((c) => {
        const j = columnIndex.get(c.name) ?? -1
        const cell = row[j] ?? null
        const isInline = inlineCol === j
        const canInline = key !== null && !isBinaryCell(cell)
        return (
          <Td
            key={c.name}
            className={cn(
              'max-w-md font-mono text-xs',
              canInline && 'focus-visible:outline-2 focus-visible:outline-blue-500'
            )}
            onDoubleClick={canInline ? () => onInline(i, j) : undefined}
            // Keyboard path to the same inline editor: focus the cell, press Enter or F2.
            // Links inside the cell (foreign keys) keep their own Enter.
            tabIndex={canInline && !isInline ? 0 : undefined}
            data-cell={`${i},${j}`}
            onKeyDown={
              canInline && !isInline
                ? (e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === 'F2') {
                      e.preventDefault()
                      onInline(i, j)
                    }
                  }
                : undefined
            }
            title={canInline ? locale.browse.editCell : undefined}
          >
            {isInline && key ? (
              <>
                <CellEditor
                  column={c.name}
                  initial={cell}
                  pending={updatePending}
                  onSave={(value: Cell) => onInlineSave(key, c.name, value)}
                  onCancel={onInlineCancel}
                />
                {updateError ? <ErrorBox error={updateError} className="mt-1" /> : null}
              </>
            ) : (
              <FkCell cell={cell} fk={fks.get(c.name)} reverse={reverse.get(c.name) ?? []} db={db} />
            )}
          </Td>
        )
      })}
    </Tr>
  )
})

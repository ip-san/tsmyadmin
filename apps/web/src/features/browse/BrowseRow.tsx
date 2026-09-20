import type { BrowseResult, Cell, ColumnTransform, InputCell, RowKey } from '@tsmyadmin/shared'
import { memo } from 'react'
import { useCellDisplay } from '@/components/cells/cell-display.ts'
import { TransformedCell } from '@/components/cells/TransformedCell.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Td, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { isOpaqueCell } from '@/lib/format.ts'
import { readSetting } from '@/lib/settings.ts'
import { CellEditor } from './CellEditor.tsx'
import { FkCell } from './FkCell.tsx'
import type { linkableForeignKeys, linkableReverseKeys } from './fk-links.ts'
import { spatialEncoding } from './geometry.ts'
import { RowActions } from './RowActions.tsx'
import { spatialCellToWkt } from './wkt.ts'

export interface BrowseRowProps {
  index: number
  row: Cell[]
  rowKey: RowKey | null
  columns: BrowseResult['columns']
  columnIndex: Map<string, number>
  fks: ReturnType<typeof linkableForeignKeys>
  reverse: ReturnType<typeof linkableReverseKeys>
  /** Display transformations by column name (stable per page: the row is memoised). */
  transforms: ReadonlyMap<string, ColumnTransform>
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
  onDelete: (index: number) => void
  onInline: (index: number, col: number) => void
  onInlineSave: (key: RowKey, column: string, value: InputCell) => void
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
  transforms,
  db,
  editable,
  selected,
  inlineCol,
  updatePending,
  updateError,
  onToggle,
  onEdit,
  onCopy,
  onDelete,
  onInline,
  onInlineSave,
  onInlineCancel,
}: BrowseRowProps) {
  const { display, dialect, downloadUrl } = useCellDisplay()
  const gridEdit = readSetting('gridEdit')
  // WKB-encoded columns (MySQL's spatial types, PostGIS): PostgreSQL's own shapes already arrive as text.
  const wktColumn = (dataType: string) => {
    if (!display.geometryAsWkt || !dialect) return false
    const encoding = spatialEncoding(dialect, dataType)
    return encoding === 'mysql-wkb' || encoding === 'ewkb-hex'
  }
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
          onDelete={() => onDelete(i)}
        />
      ) : null}
      {columns.map((c) => {
        const j = columnIndex.get(c.name) ?? -1
        const cell = row[j] ?? null
        const isInline = inlineCol === j
        const canInline = key !== null && !isOpaqueCell(cell)
        return (
          <Td
            key={c.name}
            className={cn(
              'max-w-md font-mono text-xs',
              canInline && 'focus-visible:outline-2 focus-visible:outline-blue-500'
            )}
            onDoubleClick={canInline && gridEdit === 'doubleClick' ? () => onInline(i, j) : undefined}
            onClick={
              canInline && gridEdit === 'click' && !isInline
                ? (e) => {
                    // A link (foreign key) or button inside the cell keeps its own click.
                    if (e.target instanceof Element && e.target.closest('a, button, input')) return
                    onInline(i, j)
                  }
                : undefined
            }
            // Keyboard path to the same inline editor: focus the cell, press Enter or F2.
            // Links inside the cell (foreign keys) keep their own Enter.
            tabIndex={canInline && !isInline && gridEdit !== 'off' ? 0 : undefined}
            data-cell={`${i},${j}`}
            onKeyDown={
              canInline && !isInline && gridEdit !== 'off'
                ? (e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === 'F2') {
                      e.preventDefault()
                      onInline(i, j)
                    }
                  }
                : undefined
            }
            title={canInline && gridEdit !== 'off' ? locale.browse.editCell : undefined}
          >
            {isInline && key ? (
              <>
                <CellEditor
                  column={c.name}
                  initial={cell}
                  dataType={c.dataType}
                  pending={updatePending}
                  error={updateError}
                  onSave={(value: InputCell) => onInlineSave(key, c.name, value)}
                  onCancel={onInlineCancel}
                />
                {updateError ? <ErrorBox error={updateError} className="mt-1" /> : null}
              </>
            ) : (
              <>
                {(() => {
                  const transform = transforms.get(c.name)
                  if (wktColumn(c.dataType)) {
                    const wkt = spatialCellToWkt(cell)
                    if (wkt !== null) return <span className="break-all font-mono text-xs">{wkt}</span>
                  }
                  if (transform?.kind === 'download' && key && downloadUrl && cell !== null) {
                    return (
                      <a
                        href={downloadUrl(key, c.name)}
                        download
                        className="whitespace-nowrap text-blue-700 underline dark:text-blue-300"
                        aria-label={locale.browse.downloadValue(c.name)}
                      >
                        {locale.browse.download}
                      </a>
                    )
                  }
                  return transform ? (
                    <TransformedCell cell={cell} transform={transform} />
                  ) : (
                    <FkCell cell={cell} fk={fks.get(c.name)} reverse={reverse.get(c.name) ?? []} db={db} />
                  )
                })()}
                {/* A binary or cut-off value: the page holds only its head, the download the whole of it. */}
                {key && downloadUrl && isOpaqueCell(cell) && transforms.get(c.name)?.kind !== 'download' ? (
                  <a
                    href={downloadUrl(key, c.name)}
                    download
                    className="ml-1 whitespace-nowrap text-blue-700 underline dark:text-blue-300"
                    aria-label={locale.browse.downloadValue(c.name)}
                  >
                    {locale.browse.download}
                  </a>
                ) : null}
              </>
            )}
          </Td>
        )
      })}
    </Tr>
  )
})

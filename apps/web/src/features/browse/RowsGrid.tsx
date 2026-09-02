import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BrowseOptions, BrowseResult, Cell, RowKey, RowValues } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { mutations, rowsKey, rowsQuery, type TableRef } from '@/lib/queries.ts'
import { BrowseToolbar } from './BrowseToolbar.tsx'
import { encodeColumns, visibleColumnNames } from './browse-search.ts'
import { CellEditor } from './CellEditor.tsx'
import { DeleteRowsDialog } from './DeleteRowsDialog.tsx'
import { FilterChips } from './FilterChips.tsx'
import { FkCell } from './FkCell.tsx'
import { linkableForeignKeys, linkableReverseKeys } from './fk-links.ts'
import { Pagination } from './Pagination.tsx'
import { RowActions } from './RowActions.tsx'
import { CopyRowDialog, EditRowDialog } from './RowDialogs.tsx'
import { rowKeys, rowToValues } from './row-key.ts'
import { SortHeader } from './SortHeader.tsx'

export interface RowsGridProps {
  tableRef: TableRef
  options: BrowseOptions
  page: number
  onChange: (patch: {
    page?: number
    limit?: number
    sort?: string | undefined
    filters?: string | undefined
    cols?: string | undefined
  }) => void
  /** Comma-separated visible columns from the URL (undefined = all). */
  cols?: string | undefined
}

/** Data columns exclude the hidden key column (PG ctid) appended by the adapter. */
export function visibleColumns(result: BrowseResult): BrowseResult['columns'] {
  return result.keyKind === 'ctid' ? result.columns.slice(0, -1) : result.columns
}

export function RowsGrid({ tableRef, options, page, onChange, cols }: RowsGridProps) {
  const rows = useQuery(rowsQuery(tableRef, options))
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [copyingRow, setCopyingRow] = useState<number | null>(null)
  const [inline, setInline] = useState<{ row: number; col: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const gridRef = useRef<HTMLTableElement>(null)
  // Reset transient UI state when the table, page, sort or filters change (state-from-props reset pattern):
  // the route component is reused across tables, so a selection or an open editor must not carry over.
  const optionsKey = JSON.stringify([tableRef.db, tableRef.schema ?? '', tableRef.table, options])
  const [prevOptionsKey, setPrevOptionsKey] = useState(optionsKey)
  if (prevOptionsKey !== optionsKey) {
    setPrevOptionsKey(optionsKey)
    setSelected(new Set())
    setInline(null)
    setEditingRow(null)
    setCopyingRow(null)
    setConfirmDelete(false)
    setNotice(null)
  }
  /** Closes the inline editor and returns focus to its cell (keyboard users would otherwise land on <body>). */
  const closeInline = (cell: { row: number; col: number } | null = inline) => {
    // flushSync: from a mutation callback the state update would commit in a later task, after the focus call.
    flushSync(() => setInline(null))
    if (!cell) return
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cell.row},${cell.col}"]`)?.focus()
  }
  const data = rows.data
  // Derived per page, not per render: keys/indexes are reused by every checkbox toggle and inline edit.
  const derived = useMemo(() => {
    if (!data) return null
    const allColumns = visibleColumns(data)
    return {
      allColumns,
      columnIndex: new Map(allColumns.map((c, i) => [c.name, i])),
      keys: rowKeys(data),
      fks: linkableForeignKeys(data),
      reverse: linkableReverseKeys(data),
    }
  }, [data])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: rowsKey(tableRef) })
  const update = useMutation({
    mutationFn: ({ key, values }: { key: RowKey; values: RowValues }) => mutations.updateRow(tableRef, key, values),
    onSuccess: async () => {
      setNotice(locale.rows.updated)
      closeInline()
      await invalidate()
    },
  })
  const dialogDone = async (message: string) => {
    setNotice(message)
    setEditingRow(null)
    setCopyingRow(null)
    await invalidate()
  }
  const remove = useMutation({
    mutationFn: (keys: RowKey[]) => mutations.deleteRows(tableRef, keys),
    onSuccess: async (r) => {
      setNotice(locale.rows.deleted(r.affectedRows))
      setSelected(new Set())
      setConfirmDelete(false)
      await invalidate()
    },
  })

  if (rows.isPending) return <Spinner />
  if (rows.isError) return <ErrorBox error={rows.error} onRetry={() => void rows.refetch()} />
  if (!data || !derived) return <Spinner />
  const { allColumns, columnIndex, keys, fks, reverse } = derived
  const allNames = allColumns.map((c) => c.name)
  const picked = visibleColumnNames(cols, allNames)
  const columns = picked ? allColumns.filter((c) => picked.includes(c.name)) : allColumns
  const editable = data.keyKind !== 'none'
  const selectableIdx = keys.flatMap((k, i) => (k ? [i] : []))
  const allSelected = selectableIdx.length > 0 && selectableIdx.every((i) => selected.has(i))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectableIdx))
  const toggle = (i: number) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  const selectedKeys = [...selected].map((i) => keys[i]).filter((k): k is RowKey => k !== null && k !== undefined)
  const editingKey = editingRow === null ? null : (keys[editingRow] ?? null)
  const editingValues = editingRow === null ? null : rowToValues(data, data.rows[editingRow] ?? [])
  const copyingValues = copyingRow === null ? null : rowToValues(data, data.rows[copyingRow] ?? [])

  return (
    <div className="space-y-2" aria-busy={rows.isFetching}>
      <Pagination
        page={page}
        limit={options.limit}
        total={data.total}
        approximate={data.approximate}
        shown={data.rows.length}
        onChange={onChange}
      />
      <FilterChips options={options} onClear={() => onChange({ filters: undefined, page: 1 })} />
      <BrowseToolbar
        columns={allNames}
        visible={picked}
        onColumns={(next) => onChange({ cols: encodeColumns(next, allNames) })}
        keyKind={data.keyKind}
        editable={editable}
        selectedCount={selected.size}
        canDelete={selectedKeys.length > 0}
        onDelete={() => setConfirmDelete(true)}
      />
      {/* The live region stays mounted so screen readers announce a message that appears later. */}
      <output aria-live="polite" className={notice ? 'block' : 'sr-only'}>
        {notice ? <Notice>{notice}</Notice> : null}
      </output>
      {update.isError && inline === null ? <ErrorBox error={update.error} /> : null}
      {data.rows.length === 0 ? (
        <Notice>{locale.browse.noRows}</Notice>
      ) : (
        <Table aria-label={tableRef.table} ref={gridRef}>
          <thead>
            <tr>
              {editable ? (
                <Th className="w-16">
                  <input
                    type="checkbox"
                    aria-label={locale.browse.selectAll}
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={selectableIdx.length === 0}
                  />
                </Th>
              ) : null}
              {columns.map((c) => (
                <SortHeader
                  key={c.name}
                  column={c}
                  sort={options.sort}
                  onSort={(sort) => onChange({ sort, page: 1 })}
                />
              ))}
            </tr>
          </thead>
          {/* Keyed per page/table so per-cell state (expanded values) never carries over to another row. */}
          <tbody key={optionsKey}>
            {data.rows.map((row, i) => {
              const key = keys[i] ?? null
              return (
                <Tr key={i} className={cn(selected.has(i) && 'bg-blue-50 dark:bg-blue-950/40')}>
                  {editable ? (
                    <RowActions
                      index={i}
                      addressable={key !== null}
                      selected={selected.has(i)}
                      onToggle={() => toggle(i)}
                      onEdit={() => setEditingRow(i)}
                      onCopy={() => setCopyingRow(i)}
                    />
                  ) : null}
                  {columns.map((c) => {
                    const j = columnIndex.get(c.name) ?? -1
                    const cell = row[j] ?? null
                    const isInline = inline?.row === i && inline.col === j
                    const canInline = key !== null && !isBinaryCell(cell)
                    return (
                      <Td
                        key={c.name}
                        className={cn(
                          'max-w-md font-mono text-xs',
                          canInline && 'focus-visible:outline-2 focus-visible:outline-blue-500'
                        )}
                        onDoubleClick={canInline ? () => setInline({ row: i, col: j }) : undefined}
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
                                  setInline({ row: i, col: j })
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
                              pending={update.isPending}
                              onSave={(value: Cell) => update.mutate({ key, values: { [c.name]: value } })}
                              onCancel={() => closeInline()}
                            />
                            {update.isError ? <ErrorBox error={update.error} className="mt-1" /> : null}
                          </>
                        ) : (
                          <FkCell
                            cell={cell}
                            fk={fks.get(c.name)}
                            reverse={reverse.get(c.name) ?? []}
                            db={tableRef.db}
                          />
                        )}
                      </Td>
                    )
                  })}
                </Tr>
              )
            })}
          </tbody>
        </Table>
      )}

      <EditRowDialog
        tableRef={tableRef}
        values={editingValues}
        rowKey={editingKey}
        onClose={() => setEditingRow(null)}
        onDone={dialogDone}
      />
      <CopyRowDialog
        tableRef={tableRef}
        values={copyingValues}
        onClose={() => setCopyingRow(null)}
        onDone={dialogDone}
      />

      <DeleteRowsDialog
        open={confirmDelete}
        count={selectedKeys.length}
        pending={remove.isPending}
        error={remove.error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate(selectedKeys)}
      />
    </div>
  )
}

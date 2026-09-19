import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BrowseOptions, InputCell, RowKey, RowValues } from '@tsmyadmin/shared'
import { useCallback, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Th } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { useColumnTransforms } from '@/lib/column-transforms.ts'
import { mutations, rowsKey, rowsQuery, type TableRef } from '@/lib/queries.ts'
import { BrowseRow } from './BrowseRow.tsx'
import { BrowseToolbar } from './BrowseToolbar.tsx'
import { encodeColumns, visibleColumnNames, visibleColumns } from './browse-search.ts'
import { DeleteRowsDialog } from './DeleteRowsDialog.tsx'
import { ExecutedStatement } from './ExecutedStatement.tsx'
import { FilterChips } from './FilterChips.tsx'
import { linkableForeignKeys, linkableReverseKeys } from './fk-links.ts'
import { Pagination } from './Pagination.tsx'
import { CopyRowDialog, EditRowDialog } from './RowDialogs.tsx'
import { othersOf, rowKeys, rowToValues } from './row-key.ts'
import { useRowSelection } from './row-selection.ts'
import { SelectionActions } from './SelectionActions.tsx'
import { SortHeader } from './SortHeader.tsx'
import { useSettleFocus } from './settle-focus.ts'

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

export function RowsGrid({ tableRef, options, page, onChange, cols }: RowsGridProps) {
  const rows = useQuery(rowsQuery(tableRef, options))
  const transformList = useColumnTransforms(tableRef)
  // Rebuilt only when the list changes, so the memoised rows are not all re-rendered on every render of the grid.
  const transformKey = JSON.stringify(transformList.entries)
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content; the map is rebuilt with each render
  const transforms = useMemo(() => transformList.byColumn, [transformKey])
  const queryClient = useQueryClient()
  const { selected, setSelected, toggle, clear: clearSelection } = useRowSelection()
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [copyingRow, setCopyingRow] = useState<number | null>(null)
  const [inline, setInline] = useState<{ row: number; col: number } | null>(null)
  /** The rows the delete dialog is confirming, captured as keys when it opens (never looked up by position later). */
  const [deleteTarget, setDeleteTarget] = useState<{ keys: RowKey[] } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeRef = useRef<HTMLOutputElement>(null)
  const gridRef = useRef<HTMLTableElement>(null)
  // Reset transient UI state when the table, page, sort or filters change (state-from-props reset pattern):
  // the route component is reused across tables, so a selection or an open editor must not carry over.
  const optionsKey = JSON.stringify([tableRef.db, tableRef.schema ?? '', tableRef.table, options])
  const [prevOptionsKey, setPrevOptionsKey] = useState(optionsKey)
  if (prevOptionsKey !== optionsKey) {
    setPrevOptionsKey(optionsKey)
    clearSelection()
    setInline(null)
    setEditingRow(null)
    setCopyingRow(null)
    setDeleteTarget(null)
    setNotice(null)
  }
  /** Closes the inline editor and returns focus to its cell (keyboard users would otherwise land on <body>). */
  const inlineRef = useRef(inline)
  inlineRef.current = inline
  const closeInline = useCallback(() => {
    const cell = inlineRef.current
    // flushSync: from a mutation callback the state update would commit in a later task, after the focus call.
    flushSync(() => setInline(null))
    if (!cell) return
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cell.row},${cell.col}"]`)?.focus()
  }, [])
  const data = rows.data
  const settleFocus = useSettleFocus(data, rows.isFetching, gridRef, noticeRef)
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
  // The key is taken when the button is pressed, not looked up by position when the deletion is confirmed: rows
  // refetched in a different order while the dialog is open would otherwise put another row at that position.
  const openRowDelete = useCallback(
    (index: number) => {
      const key = derived?.keys[index]
      if (key) setDeleteTarget({ keys: [key] })
    },
    [derived]
  )

  const invalidate = () => queryClient.invalidateQueries({ queryKey: rowsKey(tableRef) })
  const update = useMutation({
    mutationFn: ({ key, values }: { key: RowKey; values: RowValues }) => mutations.updateRow(tableRef, key, values),
    onSuccess: async () => {
      setNotice(locale.rows.updated)
      // The edited row may leave a filtered result set, taking the focused cell with it: checked once the
      // refetched rows are committed (see the effect on `data`), not when the fetch resolves.
      const cell = inlineRef.current
      const before = cell && data ? data.rows[cell.row] : undefined
      const column = cell ? (derived?.allColumns[cell.col]?.name ?? '') : ''
      settleFocus.current =
        cell && data && before
          ? { index: cell.row, col: cell.col, column, others: othersOf(data, before, column) }
          : null
      closeInline()
      await invalidate()
    },
  })
  const openInline = useCallback(
    (row: number, col: number) => {
      // A failure from another cell must not show under the editor that opens now.
      update.reset()
      setInline({ row, col })
    },
    [update.reset]
  )
  const cancelInline = useCallback(() => closeInline(), [closeInline])
  const saveInline = useCallback(
    (key: RowKey, column: string, value: InputCell) => update.mutate({ key, values: { [column]: value } }),
    [update.mutate]
  )
  const dialogDone = async (message: string) => {
    update.reset()
    setNotice(message)
    setEditingRow(null)
    setCopyingRow(null)
    await invalidate()
  }
  const remove = useMutation({
    mutationFn: (keys: RowKey[]) => mutations.deleteRows(tableRef, keys),
    onSuccess: async (r) => {
      update.reset()
      setNotice(locale.rows.deleted(r.affectedRows))
      clearSelection()
      setDeleteTarget(null)
      await invalidate()
      // The deleted rows' checkboxes and the (now disabled) delete button cannot take focus back; the notice is
      // announced anyway, so the pane keeps its scroll position.
      noticeRef.current?.focus({ preventScroll: true })
    },
  })

  if (rows.isPending) return <Spinner />
  if (rows.isError) return <ErrorBox error={rows.error} onRetry={() => void rows.refetch()} />
  if (!data || !derived) return <Spinner />
  const { allColumns, columnIndex, keys, fks, reverse } = derived
  const allNames = allColumns.map((c) => c.name)
  const picked = visibleColumnNames(cols, allNames)
  const columns = picked ? picked.flatMap((n) => allColumns.filter((c) => c.name === n)) : allColumns
  const editable = data.keyKind !== 'none'
  const selectableIdx = keys.flatMap((k, i) => (k ? [i] : []))
  const allSelected = selectableIdx.length > 0 && selectableIdx.every((i) => selected.has(i))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectableIdx))
  const selectedKeys = [...selected].map((i) => keys[i]).filter((k): k is RowKey => k !== null && k !== undefined)
  const deleteKeys = deleteTarget?.keys ?? []
  const editingKey = editingRow === null ? null : (keys[editingRow] ?? null)
  const editingValues = editingRow === null ? null : rowToValues(data, data.rows[editingRow] ?? [])
  const copyingValues = copyingRow === null ? null : rowToValues(data, data.rows[copyingRow] ?? [])

  return (
    <div className="space-y-2" aria-busy={rows.isFetching}>
      <ExecutedStatement statement={data.statement} />
      <Pagination
        page={page}
        limit={options.limit}
        total={data.total}
        count={data.count}
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
        onDelete={() => setDeleteTarget({ keys: selectedKeys })}
      />
      <SelectionActions
        tableRef={tableRef}
        data={data}
        selected={selected}
        keys={keys}
        editable={editable}
        onDone={dialogDone}
      />
      {/* The live region stays mounted so screen readers announce a message that appears later. */}
      <output ref={noticeRef} tabIndex={-1} aria-live="polite" className={notice ? 'block' : 'sr-only'}>
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
                <Th className="w-16" data-print-hide>
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
            {data.rows.map((row, i) => (
              <BrowseRow
                key={i}
                index={i}
                row={row}
                rowKey={keys[i] ?? null}
                columns={columns}
                columnIndex={columnIndex}
                fks={fks}
                reverse={reverse}
                transforms={transforms}
                db={tableRef.db}
                editable={editable}
                selected={selected.has(i)}
                inlineCol={inline?.row === i ? inline.col : -1}
                updatePending={update.isPending}
                updateError={inline?.row === i && update.isError ? update.error : null}
                onToggle={toggle}
                onEdit={setEditingRow}
                onCopy={setCopyingRow}
                onDelete={openRowDelete}
                onInline={openInline}
                onInlineSave={saveInline}
                onInlineCancel={cancelInline}
              />
            ))}
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
        open={deleteTarget !== null}
        count={deleteKeys.length}
        pending={remove.isPending}
        error={remove.error}
        onCancel={() => {
          setDeleteTarget(null)
          // Otherwise a failure from this attempt is still shown the next time the dialog opens, for other rows.
          remove.reset()
        }}
        onConfirm={() => remove.mutate(deleteKeys)}
      />
    </div>
  )
}

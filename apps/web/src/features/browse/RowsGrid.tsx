import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BrowseOptions, BrowseResult, Cell, RowKey, RowValues } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { ArrowDown, ArrowUp, Copy, Pencil } from 'lucide-react'
import { useState } from 'react'
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
import { CopyRowDialog, EditRowDialog } from './RowDialogs.tsx'
import { rowKeyFor, rowToValues } from './row-key.ts'
import { nextSort } from './sort.ts'

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
  // Reset transient UI state when the page/sort/filters change (state-from-props reset pattern).
  const optionsKey = JSON.stringify(options)
  const [prevOptionsKey, setPrevOptionsKey] = useState(optionsKey)
  if (prevOptionsKey !== optionsKey) {
    setPrevOptionsKey(optionsKey)
    setSelected(new Set())
    setInline(null)
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: rowsKey(tableRef) })
  const update = useMutation({
    mutationFn: ({ key, values }: { key: RowKey; values: RowValues }) => mutations.updateRow(tableRef, key, values),
    onSuccess: async () => {
      setNotice(locale.rows.updated)
      setInline(null)
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
  const data = rows.data
  const allColumns = visibleColumns(data)
  const allNames = allColumns.map((c) => c.name)
  const picked = visibleColumnNames(cols, allNames)
  const columns = picked ? allColumns.filter((c) => picked.includes(c.name)) : allColumns
  const columnIndex = new Map(allColumns.map((c, i) => [c.name, i]))
  const sortIndex = new Map(options.sort.map((s, i) => [s.column, { ...s, i }]))
  const editable = data.keyKind !== 'none'
  const keys = data.rows.map((row) => rowKeyFor(data, row))
  const fks = linkableForeignKeys(data)
  const reverse = linkableReverseKeys(data)
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
      {notice ? (
        <Notice>
          <output aria-live="polite">{notice}</output>
        </Notice>
      ) : null}
      {update.isError && inline === null ? <ErrorBox error={update.error} /> : null}
      {data.rows.length === 0 ? (
        <Notice>{locale.browse.noRows}</Notice>
      ) : (
        <Table aria-label={tableRef.table}>
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
              {columns.map((c) => {
                const entry = sortIndex.get(c.name)
                const active = entry !== undefined
                const dir = entry?.direction
                return (
                  <Th key={c.name} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-1 hover:underline',
                        active && 'text-blue-700 dark:text-blue-300'
                      )}
                      onClick={(e) => onChange({ sort: nextSort(options.sort, c.name, e.shiftKey), page: 1 })}
                      title={`${
                        dir === 'asc'
                          ? locale.browse.sortDesc
                          : dir === 'desc'
                            ? locale.browse.clearSort
                            : locale.browse.sortAsc
                      }${locale.browse.multiSortHint}`}
                    >
                      {c.name}
                      {dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden />
                      ) : dir === 'desc' ? (
                        <ArrowDown className="size-3" aria-hidden />
                      ) : null}
                      {entry && options.sort.length > 1 ? (
                        <span className="text-[10px] tabular-nums" aria-label={locale.browse.sortOrder(entry.i + 1)}>
                          {entry.i + 1}
                        </span>
                      ) : null}
                    </button>
                    <span className="ml-1 font-normal text-zinc-500 dark:text-zinc-400">{c.dataType}</span>
                  </Th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => {
              const key = keys[i] ?? null
              return (
                <Tr
                  key={key ? JSON.stringify(key) : i}
                  className={cn(selected.has(i) && 'bg-blue-50 dark:bg-blue-950/40')}
                >
                  {editable ? (
                    <Td className="whitespace-nowrap">
                      <input
                        type="checkbox"
                        aria-label={locale.rows.selectRow(i + 1)}
                        checked={selected.has(i)}
                        disabled={!key}
                        onChange={() => toggle(i)}
                      />
                      <button
                        type="button"
                        className="ml-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800"
                        aria-label={locale.rows.editRow(i + 1)}
                        disabled={!key}
                        onClick={() => setEditingRow(i)}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="ml-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                        aria-label={locale.rows.copyRow(i + 1)}
                        onClick={() => setCopyingRow(i)}
                      >
                        <Copy className="size-3.5" aria-hidden />
                      </button>
                    </Td>
                  ) : null}
                  {columns.map((c) => {
                    const j = columnIndex.get(c.name) ?? -1
                    const cell = row[j] ?? null
                    const isInline = inline?.row === i && inline.col === j
                    const canInline = key !== null && !isBinaryCell(cell)
                    return (
                      <Td
                        key={c.name}
                        className="max-w-md font-mono text-xs"
                        onDoubleClick={canInline ? () => setInline({ row: i, col: j }) : undefined}
                        title={canInline ? locale.browse.editCell : undefined}
                      >
                        {isInline && key ? (
                          <>
                            <CellEditor
                              column={c.name}
                              initial={cell}
                              pending={update.isPending}
                              onSave={(value: Cell) => update.mutate({ key, values: { [c.name]: value } })}
                              onCancel={() => setInline(null)}
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

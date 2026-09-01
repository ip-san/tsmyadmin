import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { BrowseOptions, BrowseResult, Cell, ForeignKeyDef, RowKey, RowValues } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { ArrowDown, ArrowUp, ExternalLink, Pencil } from 'lucide-react'
import { useState } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { RowForm } from '@/components/rows/RowForm.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { mutations, rowsQuery, structureQuery, type TableRef } from '@/lib/queries.ts'
import { CellEditor } from './CellEditor.tsx'
import { FilterChips } from './FilterChips.tsx'
import { fkTarget, linkableForeignKeys } from './fk-links.ts'
import { Pagination } from './Pagination.tsx'
import { rowKeyFor, rowToValues } from './row-key.ts'

export interface RowsGridProps {
  tableRef: TableRef
  options: BrowseOptions
  page: number
  onChange: (patch: { page?: number; limit?: number; sort?: string | undefined; filters?: string | undefined }) => void
}

function nextSort(current: BrowseOptions['sort'], column: string): string | undefined {
  const cur = current[0]
  if (!cur || cur.column !== column) return `${column}:asc`
  if (cur.direction === 'asc') return `${column}:desc`
  return undefined
}

/** Data columns exclude the hidden key column (PG ctid) appended by the adapter. */
export function visibleColumns(result: BrowseResult): BrowseResult['columns'] {
  return result.keyKind === 'ctid' ? result.columns.slice(0, -1) : result.columns
}

export function RowsGrid({ tableRef, options, page, onChange }: RowsGridProps) {
  const rows = useQuery(rowsQuery(tableRef, options))
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [editingRow, setEditingRow] = useState<number | null>(null)
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

  const structure = useQuery({ ...structureQuery(tableRef), enabled: editingRow !== null })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rows', tableRef.db] })
  const update = useMutation({
    mutationFn: ({ key, values }: { key: RowKey; values: RowValues }) => mutations.updateRow(tableRef, key, values),
    onSuccess: async () => {
      setNotice(locale.rows.updated)
      setEditingRow(null)
      setInline(null)
      await invalidate()
    },
  })
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
  if (rows.isError) return <ErrorBox error={rows.error} />
  const data = rows.data
  const columns = visibleColumns(data)
  const sort = options.sort[0]
  const editable = data.keyKind !== 'none'
  const keys = data.rows.map((row) => rowKeyFor(data, row))
  const fks = linkableForeignKeys(data)
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
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{locale.browse.keyHint[data.keyKind]}</span>
        {editable ? (
          <>
            <span>{locale.browse.selected(selected.size)}</span>
            <Button
              size="sm"
              variant="danger"
              disabled={selectedKeys.length === 0}
              onClick={() => setConfirmDelete(true)}
            >
              {locale.browse.deleteSelected}
            </Button>
          </>
        ) : null}
      </div>
      {notice ? (
        <Notice>
          <output aria-live="polite">{notice}</output>
        </Notice>
      ) : null}
      {update.isError && inline === null && editingRow === null ? <ErrorBox error={update.error} /> : null}
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
                const active = sort?.column === c.name
                const dir = active ? sort?.direction : undefined
                return (
                  <Th key={c.name} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-1 hover:underline',
                        active && 'text-blue-700 dark:text-blue-300'
                      )}
                      onClick={() => onChange({ sort: nextSort(options.sort, c.name), page: 1 })}
                      title={
                        dir === 'asc'
                          ? locale.browse.sortDesc
                          : dir === 'desc'
                            ? locale.browse.clearSort
                            : locale.browse.sortAsc
                      }
                    >
                      {c.name}
                      {dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden />
                      ) : dir === 'desc' ? (
                        <ArrowDown className="size-3" aria-hidden />
                      ) : null}
                    </button>
                    <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">{c.dataType}</span>
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
                    </Td>
                  ) : null}
                  {columns.map((c, j) => {
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
                          <FkCell cell={cell} fk={fks.get(c.name)} db={tableRef.db} />
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

      <Dialog open={editingRow !== null} title={locale.rows.editTitle} onClose={() => setEditingRow(null)}>
        {structure.isPending ? (
          <Spinner />
        ) : structure.isError ? (
          <ErrorBox error={structure.error} />
        ) : editingKey && editingValues ? (
          <RowForm
            key={editingRow}
            columns={structure.data.columns}
            mode="edit"
            initial={editingValues}
            pending={update.isPending}
            error={update.error}
            onCancel={() => setEditingRow(null)}
            onSubmit={(values) => {
              if (Object.keys(values).length === 0) {
                setNotice(locale.rows.nothingChanged)
                setEditingRow(null)
                return
              }
              update.mutate({ key: editingKey, values })
            }}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={confirmDelete}
        title={locale.browse.deleteSelected}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} disabled={remove.isPending}>
              {locale.common.cancel}
            </Button>
            <Button variant="danger" onClick={() => remove.mutate(selectedKeys)} disabled={remove.isPending}>
              {locale.common.delete}
            </Button>
          </>
        }
      >
        <p>{locale.browse.deleteConfirm(selectedKeys.length)}</p>
        {remove.isError ? <ErrorBox error={remove.error} className="mt-2" /> : null}
      </Dialog>
    </div>
  )
}

/** A cell value, followed by a link to the referenced row when the column is a single-column foreign key. */
function FkCell({ cell, fk, db }: { cell: Cell; fk: ForeignKeyDef | undefined; db: string }) {
  const target = fk ? fkTarget(fk, cell, db) : null
  if (!fk || !target) return <CellValue cell={cell} />
  const refColumn = fk.refColumns[0] ?? ''
  return (
    <span className="inline-flex items-center gap-1">
      <CellValue cell={cell} />
      <Link
        to="/db/$db/table/$table"
        params={{ db: target.db, table: target.table }}
        search={{ ...(target.schema ? { schema: target.schema } : {}), filters: target.filters, page: 1 }}
        className="text-blue-600 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-100"
        aria-label={locale.browse.fkLink(target.table, refColumn)}
        title={locale.browse.fkLink(target.table, refColumn)}
      >
        <ExternalLink className="size-3" aria-hidden />
      </Link>
    </span>
  )
}

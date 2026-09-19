import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { RowValues } from '@tsmyadmin/shared'
import { isViewKind } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { RowForm } from '@/components/rows/RowForm.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { mutations, rowsKey, structureQuery, type TableRef } from '@/lib/queries.ts'

/** How many rows the insert form holds at once. */
const ROW_COUNTS = [1, 2, 3, 5, 10]

export function InsertPage({ tableRef }: { tableRef: TableRef }) {
  const structure = useQuery(structureQuery(tableRef))
  const queryClient = useQueryClient()
  const [inserted, setInserted] = useState(0)
  const [rowCount, setRowCount] = useState(1)
  const [round, setRound] = useState(0)
  const formRef = useRef<HTMLDivElement>(null)
  // One row after another, as phpMyAdmin does: a failure stops there, and the rows already written stay (the
  // notice counts them), so the form keeps what was typed for the rest.
  const insert = useMutation({
    mutationFn: async ({ rows }: { rows: RowValues[] }) => {
      let done = 0
      try {
        for (const values of rows) done += (await mutations.insertRow(tableRef, values)).affectedRows
      } finally {
        if (done > 0) setInserted((n) => n + done)
      }
      return done
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: rowsKey(tableRef) }),
    // The page stays: the notice confirms the insert and links to the browse view; the form is remounted blank
    // (via `key`) so entering more rows needs no navigation.
    onSuccess: () => setRound((r) => r + 1),
  })
  // After a remount the focused submit button is gone; keyboard users continue from the first field.
  useEffect(() => {
    if (round > 0)
      // Not the generated key: typing there would replace the generated value.
      formRef.current
        ?.querySelector<HTMLElement>(
          'tr:not([data-generated]) input:not([type="checkbox"]):not([disabled]), tr:not([data-generated]) textarea:not([disabled])'
        )
        ?.focus()
  }, [round])
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
  if (isViewKind(structure.data.kind))
    return (
      <Notice>{structure.data.kind === 'sequence' ? locale.browse.readOnlySequence : locale.browse.readOnly}</Notice>
    )
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">{locale.rows.insertTitle}</h2>
      <output aria-live="polite" className={inserted > 0 ? 'block' : 'sr-only'}>
        {inserted > 0 ? (
          <Notice>
            {locale.rows.inserted(inserted)}{' '}
            <Link
              to="/db/$db/table/$table"
              params={{ db: tableRef.db, table: tableRef.table }}
              search={tableRef.schema ? { schema: tableRef.schema } : {}}
              className="underline"
            >
              {locale.rows.backToBrowse}
            </Link>
          </Notice>
        ) : null}
      </output>
      <label className="flex items-center gap-2 text-sm text-ink">
        {locale.rows.rowCount}
        <Select value={rowCount} onChange={(e) => setRowCount(Number(e.target.value))} className="w-auto py-1">
          {ROW_COUNTS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </label>
      <div ref={formRef}>
        <RowForm
          key={round}
          columns={structure.data.columns}
          foreignKeys={structure.data.foreignKeys}
          rowCount={rowCount}
          mode="insert"
          pending={insert.isPending}
          error={insert.error}
          onSubmit={(_, rows) => insert.mutate({ rows })}
        />
      </div>
    </div>
  )
}

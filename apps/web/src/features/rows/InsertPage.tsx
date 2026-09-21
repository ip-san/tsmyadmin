import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { InsertPreview, RowValues } from '@tsmyadmin/shared'
import { isViewKind } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { RowForm } from '@/components/rows/RowForm.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useColumnTransforms } from '@/lib/column-transforms.ts'
import { mutations, rowsKey, structureQuery, type TableRef } from '@/lib/queries.ts'
import { resolveSettings } from '@/lib/settings.ts'

type After = 'blank' | 'keep' | 'browse'

/** How many rows the insert form holds at once. */
const ROW_COUNTS = [1, 2, 3, 5, 10]

export function InsertPage({ tableRef }: { tableRef: TableRef }) {
  const structure = useQuery(structureQuery(tableRef))
  const inputs = useColumnTransforms(tableRef).inputByColumn
  const queryClient = useQueryClient()
  const [inserted, setInserted] = useState(0)
  const [rowCount, setRowCount] = useState(() => resolveSettings().insertRowCount)
  const [round, setRound] = useState(0)
  // What happens once the rows are in (phpMyAdmin's "After insertion"), and whether a refused row is skipped.
  const [after, setAfter] = useState<After>('blank')
  const [ignore, setIgnore] = useState(false)
  const [skipped, setSkipped] = useState(0)
  const [statements, setStatements] = useState<InsertPreview[] | null>(null)
  const navigate = useNavigate()
  const formRef = useRef<HTMLDivElement>(null)
  // One row after another, as phpMyAdmin does: a failure stops there, and the rows already written stay (the
  // notice counts them), so the form keeps what was typed for the rest.
  const insert = useMutation({
    mutationFn: async ({ rows }: { rows: RowValues[] }) => {
      let done = 0
      try {
        for (const values of rows) done += (await mutations.insertRow(tableRef, values, ignore)).affectedRows
      } finally {
        if (done > 0) setInserted((n) => n + done)
      }
      // A row the server refused and the option let pass writes nothing: it is counted apart, not lost silently.
      if (ignore) setSkipped((n) => n + rows.length - done)
      return done
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: rowsKey(tableRef) }),
    // The page stays: the notice confirms the insert and links to the browse view; the form is remounted blank
    // (via `key`) so entering more rows needs no navigation.
    onSuccess: async () => {
      if (after === 'blank') setRound((r) => r + 1)
      if (after === 'browse')
        await navigate({
          to: '/db/$db/table/$table',
          params: { db: tableRef.db, table: tableRef.table },
          search: tableRef.schema ? { schema: tableRef.schema } : {},
        })
    },
  })
  const preview = useMutation({
    mutationFn: async (rows: RowValues[]) => {
      const out: InsertPreview[] = []
      for (const values of rows) out.push(await mutations.previewInsert(tableRef, values, ignore))
      return out
    },
    onSuccess: setStatements,
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
      {skipped > 0 ? <Notice>{locale.rows.ignoredRows(skipped)}</Notice> : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          {locale.rows.afterInsert.label}
          <Select value={after} onChange={(e) => setAfter(e.target.value as After)} className="w-auto py-1">
            <option value="blank">{locale.rows.afterInsert.blank}</option>
            <option value="keep">{locale.rows.afterInsert.keep}</option>
            <option value="browse">{locale.rows.afterInsert.browse}</option>
          </Select>
        </label>
        <label className="flex items-center gap-1 text-sm text-ink" title={locale.rows.ignoreHint}>
          <input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} />
          {locale.rows.ignoreErrors}
        </label>
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
      </div>
      <div ref={formRef}>
        <RowForm
          inputTransforms={inputs}
          key={round}
          columns={structure.data.columns}
          foreignKeys={structure.data.foreignKeys}
          rowCount={rowCount}
          mode="insert"
          pending={insert.isPending}
          error={insert.error ?? preview.error}
          onSubmit={(_, rows) => insert.mutate({ rows })}
          onPreview={(rows) => preview.mutate(rows)}
        />
      </div>
      <Dialog
        open={statements !== null}
        title={locale.rows.previewTitle}
        onClose={() => setStatements(null)}
        footer={<Button onClick={() => setStatements(null)}>{locale.common.close}</Button>}
      >
        <p className="mb-2 text-xs text-ink-sub">{locale.rows.previewNote}</p>
        {statements?.map((st, i) => (
          <div key={i} className="mb-3 space-y-1">
            <pre
              aria-label="SQL"
              className="overflow-x-auto rounded border border-line bg-surface-sub p-3 font-mono text-xs"
            >
              {st.sql};
            </pre>
            {st.params.length > 0 ? (
              <p className="break-all font-mono text-xs text-ink-sub">
                {locale.rows.boundValues}: {st.params.map((p) => JSON.stringify(p)).join(', ')}
              </p>
            ) : null}
          </div>
        ))}
      </Dialog>
    </div>
  )
}

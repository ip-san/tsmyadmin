import type { BrowseResult, Cell, RowKey } from '@tsmyadmin/shared'
import { isTruncatedCell, toCsv } from '@tsmyadmin/shared'
import { ChartColumn, Copy, Download, Pencil } from 'lucide-react'
import { useState } from 'react'
import { ResultChart } from '@/components/results/ResultChart.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { copyText, toTsv } from '@/lib/clipboard.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import type { TableRef } from '@/lib/queries.ts'
import { EditRowsDialog } from './RowDialogs.tsx'
import { rowToValues } from './row-key.ts'

const t = locale.browse.selection

/**
 * What can be done with the ticked rows of the page (phpMyAdmin's "With selected"): edit them together, download
 * or copy them — and a chart of the whole page. Deleting stays in the toolbar with its confirmation.
 */
export function SelectionActions({
  tableRef,
  data,
  selected,
  keys,
  editable,
  onDone,
}: {
  tableRef: TableRef
  data: BrowseResult
  selected: ReadonlySet<number>
  keys: (RowKey | null)[]
  editable: boolean
  onDone: (notice: string) => Promise<void>
}) {
  const [editing, setEditing] = useState<{ key: RowKey; values: Record<string, Cell> }[] | null>(null)
  const [chart, setChart] = useState(false)
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  // A ctid table carries its row address as a hidden last column: not part of what the user sees.
  const columns = data.keyKind === 'ctid' ? data.columns.slice(0, -1) : data.columns
  const names = columns.map((c) => c.name)
  const picked = [...selected].sort((a, b) => a - b)
  const rows = picked.map((i) => (data.rows[i] ?? []).slice(0, names.length))
  // A value cut for display would be copied as if it were whole: those rows go through the Export tab instead.
  const cut = rows.some((row) => row.some((cell) => isTruncatedCell(cell)))
  const canEdit = editable && picked.every((i) => keys[i])
  const label = `${tableRef.table}-selected`
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {picked.length > 0 ? (
        <>
          {canEdit ? (
            <Button
              size="sm"
              aria-haspopup="dialog"
              onClick={() =>
                setEditing(
                  picked.flatMap((i) => {
                    const key = keys[i]
                    return key ? [{ key, values: rowToValues(data, data.rows[i] ?? []) }] : []
                  })
                )
              }
            >
              <Pencil className="size-3" aria-hidden />
              {t.edit}
            </Button>
          ) : null}
          {cut ? (
            <span className="text-ink-sub">{t.cut}</span>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() =>
                  downloadText(safeFilename(label, 'csv'), toCsv(names, rows, false), 'text/csv;charset=utf-8')
                }
              >
                <Download className="size-3" aria-hidden />
                {t.csv}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  downloadText(
                    safeFilename(label, 'json'),
                    JSON.stringify(
                      rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null]))),
                      null,
                      2
                    ),
                    'application/json'
                  )
                }
              >
                <Download className="size-3" aria-hidden />
                {t.json}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  copyText(toTsv(names, rows, false)).then(
                    () => setCopied('done'),
                    () => setCopied('failed')
                  )
                }
              >
                <Copy className="size-3" aria-hidden />
                {t.copy}
              </Button>
            </>
          )}
        </>
      ) : null}
      <Button size="sm" aria-pressed={chart} onClick={() => setChart((c) => !c)}>
        <ChartColumn className="size-3" aria-hidden />
        {t.chart}
      </Button>
      <output aria-live="polite" className="text-ink-sub">
        {copied === 'done' ? locale.sql.copied : copied === 'failed' ? locale.sql.copyFailed : ''}
      </output>
      {chart && data.rows.length > 0 ? (
        <div className="w-full">
          <ResultChart result={{ ...data, columns, rows: data.rows.map((r) => r.slice(0, names.length)) }} />
        </div>
      ) : null}
      <EditRowsDialog
        tableRef={tableRef}
        rows={editing}
        onClose={() => setEditing(null)}
        onDone={async (notice) => {
          setEditing(null)
          await onDone(notice)
        }}
      />
    </div>
  )
}

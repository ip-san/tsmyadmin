import type { ResultSet } from '@tsmyadmin/shared'
import { isTruncatedCell, toCsv } from '@tsmyadmin/shared'
import { ChartColumn, Copy, Download, Printer } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { copyText, toTsv } from '@/lib/clipboard.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'

const CSV_SAFE_PREF = 'sql.csvSafe'

/**
 * What can be done with one result set as it is on screen (up to maxRows): download it, copy it for a
 * spreadsheet, print it, or chart it. Hidden on paper.
 */
export function ResultActions({
  result,
  label,
  index,
  chartOpen,
  onToggleChart,
  onPrint,
}: {
  result: ResultSet
  label: string
  index: number
  chartOpen: boolean
  onToggleChart: () => void
  onPrint: () => void
}) {
  const names = result.columns.map((c) => c.name)
  const [csvSafe, setCsvSafe] = useState(() => readPreference(CSV_SAFE_PREF, z.boolean(), false))
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  // A file or a paste built from the screen would carry the cut values as if they were whole; the export tab
  // reads uncapped. Printing and charting show the screen as it is, so they stay.
  const cut = result.rows.some((row) => row.some((cell) => isTruncatedCell(cell)))
  const of = (action: string) => `${locale.sql.resultActions(index + 1)} ${action}`
  const csv = () =>
    downloadText(safeFilename(label, 'csv'), toCsv(names, result.rows, csvSafe), 'text/csv;charset=utf-8')
  const json = () =>
    downloadText(
      safeFilename(label, 'json'),
      JSON.stringify(
        result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null]))),
        null,
        2
      ),
      'application/json'
    )
  const copy = () => {
    copyText(toTsv(names, result.rows, csvSafe)).then(
      () => setCopied('done'),
      () => setCopied('failed')
    )
  }
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-3 font-normal print:hidden">
      {cut ? (
        <span className="text-xs text-ink-sub">{locale.sql.downloadTruncated}</span>
      ) : (
        <>
          <Button size="sm" onClick={csv} aria-label={of(locale.sql.downloadCsv)}>
            <Download className="size-3" aria-hidden />
            {locale.sql.downloadCsv}
          </Button>
          <Button size="sm" onClick={json} aria-label={of(locale.sql.downloadJson)}>
            <Download className="size-3" aria-hidden />
            {locale.sql.downloadJson}
          </Button>
          <Button size="sm" onClick={copy} aria-label={of(locale.sql.copy)}>
            <Copy className="size-3" aria-hidden />
            {locale.sql.copy}
          </Button>
        </>
      )}
      <Button size="sm" onClick={onPrint} aria-label={of(locale.sql.print)}>
        <Printer className="size-3" aria-hidden />
        {locale.sql.print}
      </Button>
      <Button size="sm" onClick={onToggleChart} aria-pressed={chartOpen} aria-label={of(locale.sql.chart.toggle)}>
        <ChartColumn className="size-3" aria-hidden />
        {locale.sql.chart.toggle}
      </Button>
      {cut ? null : (
        <label className="flex items-center gap-2 py-1 text-xs text-ink-sub">
          <input
            type="checkbox"
            checked={csvSafe}
            onChange={(e) => {
              setCsvSafe(e.target.checked)
              writePreference(CSV_SAFE_PREF, e.target.checked)
            }}
          />
          {locale.export.csvSafe}
        </label>
      )}
      {/* Always mounted, so the outcome of a copy is announced (a region that appears with its text is not). */}
      <output aria-live="polite" className="text-xs text-ink-sub">
        {copied === 'done' ? locale.sql.copied : copied === 'failed' ? locale.sql.copyFailed : ''}
      </output>
    </span>
  )
}

import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'

const t = locale.designer

/** What the Designer's buttons do to the diagram as a whole: columns shown, relate mode, layout reset, export. */
export function DesignerToolbar({
  allColumns,
  onAllColumns,
  relate,
  onRelate,
  canReset,
  onReset,
  svg,
  fileBase,
  children,
}: {
  allColumns: boolean
  onAllColumns: (on: boolean) => void
  relate: boolean
  onRelate: (on: boolean) => void
  canReset: boolean
  onReset: () => void
  /** The diagram as a file, built when asked. */
  svg: () => string
  fileBase: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      <label className="flex items-center gap-1 text-sm text-ink">
        <input
          type="checkbox"
          checked={allColumns || relate}
          disabled={relate}
          onChange={(e) => onAllColumns(e.target.checked)}
        />
        {t.allColumns}
      </label>
      <Button size="sm" aria-pressed={relate} onClick={() => onRelate(!relate)}>
        {relate ? t.relateStop : t.relateStart}
      </Button>
      {children}
      <div className="ml-auto" />
      <Button size="sm" disabled={!canReset} onClick={onReset}>
        {t.resetLayout}
      </Button>
      <Button
        size="sm"
        onClick={() => downloadText(safeFilename(`${fileBase}-designer`, 'svg'), svg(), 'image/svg+xml;charset=utf-8')}
      >
        {t.exportSvg}
      </Button>
      <Button size="sm" title={t.exportPdfHint} onClick={() => window.print()}>
        {t.exportPdf}
      </Button>
    </div>
  )
}

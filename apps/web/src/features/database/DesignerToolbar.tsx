import type { DesignerView } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { Select } from '@/components/ui/Field.tsx'
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
  dia,
  eps,
  fileBase,
  view,
  onView,
  fullscreen,
  onFullscreen,
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
  dia: () => string
  eps: () => string
  fileBase: string
  /** How the diagram is drawn, and what changes it. */
  view: DesignerView
  onView: (patch: Partial<DesignerView>) => void
  fullscreen: boolean
  onFullscreen: () => void
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
      <label className="flex items-center gap-1 text-sm text-ink">
        <input
          type="checkbox"
          checked={view.compact && !relate}
          disabled={relate}
          onChange={(e) => onView({ compact: e.target.checked })}
        />
        {t.compact}
      </label>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input type="checkbox" checked={view.snap} onChange={(e) => onView({ snap: e.target.checked })} />
        {t.snap}
      </label>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input type="checkbox" checked={view.showLines} onChange={(e) => onView({ showLines: e.target.checked })} />
        {t.showLines}
      </label>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input
          type="checkbox"
          checked={view.lineLabels}
          disabled={!view.showLines}
          onChange={(e) => onView({ lineLabels: e.target.checked })}
        />
        {t.lineLabels}
      </label>
      <label className="flex items-center gap-1 text-sm text-ink">
        {t.lineStyle}
        <Select
          aria-label={t.lineStyle}
          value={view.lineStyle}
          disabled={!view.showLines}
          onChange={(e) => onView({ lineStyle: e.target.value as DesignerView['lineStyle'] })}
          className="w-auto py-1"
        >
          <option value="curve">{t.lineStyles.curve}</option>
          <option value="straight">{t.lineStyles.straight}</option>
          <option value="polyline">{t.lineStyles.polyline}</option>
        </Select>
      </label>
      <Button size="sm" aria-pressed={fullscreen} onClick={onFullscreen}>
        {fullscreen ? t.exitFullscreen : t.fullscreen}
      </Button>
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
      <Button
        size="sm"
        onClick={() =>
          downloadText(safeFilename(`${fileBase}-designer`, 'dia'), dia(), 'application/x-dia-diagram;charset=utf-8')
        }
      >
        {t.exportDia}
      </Button>
      <Button
        size="sm"
        onClick={() =>
          downloadText(safeFilename(`${fileBase}-designer`, 'eps'), eps(), 'application/postscript;charset=utf-8')
        }
      >
        {t.exportEps}
      </Button>
      <Button size="sm" title={t.exportPdfHint} onClick={() => window.print()}>
        {t.exportPdf}
      </Button>
    </div>
  )
}

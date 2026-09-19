import { SlidersHorizontal } from 'lucide-react'
import { type CellDisplay, useCellDisplay } from '@/components/cells/cell-display.ts'
import { locale } from '@/config/locale.ts'

const OPTIONS: { key: keyof CellDisplay; label: string }[] = [
  { key: 'fullText', label: locale.browse.fullText },
  { key: 'fkDisplay', label: locale.browse.fkDisplay },
  { key: 'binaryAsHex', label: locale.browse.binaryAsHex },
  { key: 'geometryAsWkt', label: locale.browse.geometryAsWkt },
]

/** phpMyAdmin's browse options: full texts, binary as hex, geometry as WKT. Remembered by the browser. */
export function DisplayMenu() {
  const { display, setDisplay } = useCellDisplay()
  if (!setDisplay) return null
  return (
    <details className="relative">
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded border border-line px-2 py-1 text-xs text-ink hover:bg-surface-sub">
        <SlidersHorizontal className="size-3.5" aria-hidden />
        {locale.browse.display}
      </summary>
      <fieldset className="absolute left-0 z-10 mt-1 w-60 space-y-1 rounded border border-line bg-surface p-2 shadow-lg">
        <legend className="sr-only">{locale.browse.display}</legend>
        {OPTIONS.map((o) => (
          <label key={o.key} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={display[o.key]}
              onChange={(e) => setDisplay({ ...display, [o.key]: e.target.checked })}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
    </details>
  )
}

import type { RelationDef } from '@tsmyadmin/shared'
import { useState } from 'react'
import type { Point } from '@/components/schema-diagram/layout.ts'
import { MAX_HOPS, neighbourhood } from '@/components/schema-diagram/neighbourhood.ts'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale-screens.ts'

const t = locale.designer.focus

/** What the Designer draws: the tables and keys, all of them or those around the focus. */
interface Shape {
  tables: string[]
  relations: RelationDef[]
}

/**
 * The Designer drawn around one table (`focus`, from the address, so a view of it can be shared): the tables
 * within `hops` keys of it, laid out on their own. Boxes moved meanwhile stay where they are put until the focus
 * changes, and are not saved: the saved layout is the whole database's, and a focused one would scatter it.
 */
export function useDesignerFocus({
  focus,
  hops,
  names,
  onChange,
}: {
  focus: string | undefined
  hops: number
  /** The tables there are to focus on. */
  names: readonly string[]
  onChange: (focus: string | undefined, hops: number) => void
}) {
  const key = JSON.stringify([focus ?? '', hops])
  const [moved, setMoved] = useState<{ key: string; positions: Record<string, Point> }>({ key, positions: {} })
  const own = moved.key === key ? moved.positions : {}
  const missing = focus !== undefined && !names.includes(focus)
  const on = focus !== undefined && !missing
  return {
    on,
    /** The tables and keys to draw. */
    apply<S extends Shape>(shape: S): S {
      if (!on) return shape
      const near = neighbourhood(shape.tables, shape.relations, focus, hops)
      return {
        ...shape,
        tables: shape.tables.filter((n) => near.has(n)),
        relations: shape.relations.filter((r) => near.has(r.table) && near.has(r.refTable)),
      }
    },
    /** Where the boxes are: the automatic layout of what is drawn, with the boxes moved (saved, or while focused). */
    positions: (auto: Record<string, Point>, saved: Record<string, Point>) =>
      on ? { ...auto, ...own } : { ...auto, ...saved },
    /** A box moved: kept for this focus only while focused, otherwise by `save`. */
    move(table: string, to: Point, commit: boolean, save: (table: string, to: Point, commit: boolean) => void) {
      if (on) setMoved({ key, positions: { ...own, [table]: to } })
      else save(table, to, commit)
    },
    control: (
      <fieldset className="flex items-center gap-1 text-sm text-ink">
        <legend className="sr-only">{t.legend}</legend>
        <label className="flex items-center gap-1">
          {t.around}
          <Select value={on ? focus : ''} onChange={(e) => onChange(e.target.value || undefined, hops)}>
            <option value="">{t.all}</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1">
          {t.hops}
          <Select value={hops} disabled={!on} onChange={(e) => onChange(focus, Number(e.target.value))}>
            {Array.from({ length: MAX_HOPS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {t.hopsN(n)}
              </option>
            ))}
          </Select>
        </label>
      </fieldset>
    ),
    /** Said above the diagram: what is drawn while focused, or that the table asked for is not here (renamed, dropped). */
    // A status line from the start (empty without a focus), so a change of focus or reach is heard.
    notice: (drawn: number, total: number) => (
      <p
        role="status"
        // Empty, it takes no room in the column of the page; a table not found is said as a warning.
        className={
          missing
            ? 'rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200'
            : 'text-xs text-ink-sub empty:mb-0'
        }
      >
        {missing ? t.missing(focus ?? '') : on ? t.showing(focus ?? '', hops, drawn, total) : ''}
      </p>
    ),
  }
}

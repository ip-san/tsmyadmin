import type { RelationDef } from '@tsmyadmin/shared'
import { useEffect, useState } from 'react'
import { type DiagramOverlay, mergeOverlays } from '@/components/schema-diagram/overlay.ts'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import { useCompare } from './DesignerCompare.tsx'
import { useReferences } from './DesignerReferences.tsx'
import { useUsage } from './DesignerUsage.tsx'

const t = locale.designer

/**
 * What is laid over the Designer's diagram: a snapshot to compare with (from the URL), or the table reads and the
 * reference check (from the toolbar), which add to each other. Comparing replaces both: its colours mean added,
 * removed and changed, and the others' would read as the same. The toolbar controls, the panels around the
 * diagram, and the one overlay to draw come from here, so the Designer only places them.
 */
export function useDesignerOverlays({
  db,
  schema,
  compare,
  names,
  keys,
}: {
  db: string
  schema: string | undefined
  compare: string | undefined
  /** The tables drawn: only theirs are checked. */
  names: readonly string[]
  keys: readonly RelationDef[] | undefined
}) {
  const comparing = useCompare(db, schema, compare)
  const free = compare === undefined
  const [usageAsked, setUsageAsked] = useState(false)
  const [refsAsked, setRefsAsked] = useState(false)
  const [refsRun, setRefsRun] = useState(0)
  // Comparing turns the check off for good: back from it, the reader presses again for a check of the schema as it
  // is now, rather than seeing the one from before the comparison.
  useEffect(() => {
    if (!free) setRefsAsked(false)
  }, [free])
  const usage = useUsage(db, schema, usageAsked && free)
  const keyed = [...new Set((keys ?? []).map((r) => r.table))].filter((n) => names.includes(n))
  const refsOn = refsAsked && free
  // Not before the keys are read: there would be no table to check, and "0 tables checked".
  const refs = useReferences(db, schema, keyed, { on: refsOn && keys !== undefined, run: refsRun })
  const failed = [...refs.checks.values()].filter((c) => c === 'failed').length
  const status = refs.checking
    ? t.refCheck.checking
    : refsOn && keys !== undefined
      ? t.refCheck.done(refs.checks.size, failed)
      : ''
  const controls = (
    <>
      <label className="flex items-center gap-1 text-sm text-ink" title={t.usage.toggleHint}>
        <input
          type="checkbox"
          checked={usageAsked && free}
          disabled={!free}
          onChange={(e) => setUsageAsked(e.target.checked)}
        />
        {t.usage.toggle}
      </label>
      <Button
        size="sm"
        aria-pressed={refsOn}
        disabled={!free}
        title={t.refCheck.checkHint}
        onClick={() => {
          if (!refsAsked) setRefsRun((n) => n + 1)
          setRefsAsked(!refsAsked)
        }}
      >
        {t.refCheck.check}
      </Button>
      <span role="status" className="text-xs text-ink-sub">
        {status}
      </span>
    </>
  )
  return {
    /** The tables and keys to draw, with the snapshot's overlay when comparing. */
    shape: comparing.shape,
    controls,
    above: comparing.panel,
    below: usage.panel,
    refsOn,
    checks: refs.checks,
    /** The overlay to draw, given what `shape` returned: the comparison's, or the others laid together. */
    overlay: (compared: DiagramOverlay | undefined) => compared ?? mergeOverlays(usage.overlay, refs.overlay),
  }
}

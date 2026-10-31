import { useQueries } from '@tanstack/react-query'
import { useEffect } from 'react'
import { PreviewDialog } from '@/components/ddl/PreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { structureQuery } from '@/lib/queries.ts'
import { forgetTried, type TriedIndex, useTriedIndexes } from './tried-indexes.ts'

const t = locale.plan

/**
 * The indexes tried from a plan and still there, once the plan is closed: each with a way to drop it (through the
 * preview). Each is looked up in its table first: one dropped elsewhere (the table's Structure, another tool) is
 * forgotten, and one whose table cannot be read now is not offered (the drop could not be checked).
 */
export function TriedIndexes({ scope, db, schema }: { scope: string; db: string; schema?: string | undefined }) {
  const tried = useTriedIndexes(scope, db, schema)
  const structures = useQueries({ queries: tried.map((x) => structureQuery({ db, schema, table: x.table })) })
  const there = (x: TriedIndex, i: number) =>
    structures[i]?.data?.indexes.some((ix) => ix.name.toLowerCase() === x.name.toLowerCase())
  const gone = tried.filter((x, i) => structures[i]?.data !== undefined && !there(x, i))
  useEffect(() => {
    for (const x of gone) forgetTried(scope, x)
  }, [scope, gone])
  const shown = tried.filter(there)
  const flow = useDdlFlow(db, schema, (op) => {
    if (op.op === 'dropIndex')
      forgetTried(scope, { db, schema: schema ?? null, table: op.table, name: op.name, columns: [] })
  })
  // Kept while its dialog is open: the last one dropped still says it was.
  if (shown.length === 0 && flow.op === null) return null
  return (
    <section aria-label={t.triedGroup} className="space-y-1 rounded border border-line p-2 text-xs">
      <h3 className="font-semibold text-ink">{t.triedGroup}</h3>
      <p className="text-ink-sub">{t.triedIntro}</p>
      <ul className="space-y-1">
        {shown.map((x) => (
          <li key={`${x.table}\0${x.name}`} className="flex flex-wrap items-center gap-2">
            <span className="text-ink">{t.triedItem(x.table, x.name, x.columns)}</span>
            <Button
              size="sm"
              aria-disabled={flow.running || undefined}
              onClick={() => !flow.running && flow.preview({ op: 'dropIndex', table: x.table, name: x.name })}
            >
              {t.trialUndo(x.name)}
            </Button>
          </li>
        ))}
      </ul>
      <PreviewDialog
        flow={flow}
        title={(op) => locale.ddl.titles[op.op]}
        destructive={() => true}
        hint={t.triedDropHint}
        successMessage={(op) => locale.ddl.executed(locale.ddl.titles[op.op])}
      />
    </section>
  )
}

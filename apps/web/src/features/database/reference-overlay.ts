import type { ReferenceCheck } from '@tsmyadmin/shared'
import type { DiagramOverlay } from '@/components/schema-diagram/overlay.ts'
import { relationKey } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { locale } from '@/config/locale-screens.ts'

const t = locale.designer.refCheck

/** What the check found for one table: its keys' counts, or that it could not be checked (a timeout, say). */
export type TableCheck = readonly ReferenceCheck[] | 'failed'

/**
 * The keys with rows whose parent is missing, lit and badged with the count; the rest of the picture stays as it
 * is (the overlay only adds). A table that could not be checked lights nothing: the table under the diagram says so.
 */
export function referenceOverlay(checks: ReadonlyMap<string, TableCheck>): DiagramOverlay {
  const relations = new Map<string, 'delete'>()
  const relationBadges = new Map<string, string>()
  for (const [table, check] of checks) {
    if (check === 'failed') continue
    for (const c of check) {
      if (c.orphans === 0) continue
      const key = relationKey({ table, name: c.name })
      relations.set(key, 'delete')
      relationBadges.set(key, t.orphans(c.orphans))
    }
  }
  return { tables: new Map(), relations, columns: new Map(), relationBadges, fade: false }
}

/** What the table under the diagram says for one key: the count, that it failed, or nothing before the check. */
export function orphansText(checks: ReadonlyMap<string, TableCheck>, table: string, name: string): string | null {
  const check = checks.get(table)
  if (check === undefined) return null
  if (check === 'failed') return t.failed
  const found = check.find((c) => c.name === name)
  return found ? found.orphans.toLocaleString() : null
}

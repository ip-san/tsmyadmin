import type { ReferenceCheck } from '@tsmyadmin/shared'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import type { DiagramOverlay } from '@/components/schema-diagram/overlay.ts'
import { locale } from '@/config/locale-screens.ts'
import { eachLimited } from '@/lib/each-limited.ts'

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
  // Checked, but the key is not among the table's (made since, or another table's of the same name): not checked.
  const found = check.find((c) => c.name === name)
  return found ? t.count(found.orphans) : t.notChecked
}

/**
 * Every table's check, a few at a time (`eachLimited`): each reads its table in full. A table whose check fails (a
 * timeout, say) is `failed`; the others' answers stand. Once `signal` aborts, no more tables are started.
 */
export async function checkAll(
  tables: readonly string[],
  check: (table: string) => Promise<readonly ReferenceCheck[]>,
  options: { limit?: number; signal?: AbortSignal | undefined } = {}
): Promise<Map<string, TableCheck>> {
  const done = await eachLimited(tables, check, options)
  return new Map(done.map(({ item, settled }) => [item, settled.ok ? settled.value : 'failed']))
}

import type { IndexUsage, TableUsageReport } from '@tsmyadmin/shared'
import type { DiagramOverlay, Tone } from '@/components/schema-diagram/overlay.ts'
import { locale } from '@/config/locale-screens.ts'

const t = locale.designer.usage

/**
 * Which way each table is mostly read: in full (`scan`) when its full reads outnumber its index reads, through an
 * index otherwise. A table not read at all carries no tone, so it is drawn faint with the rest of what the picture
 * does not point at. Every table read gets its counts as a badge.
 */
export function usageOverlay(report: TableUsageReport): DiagramOverlay {
  const tables = new Map<string, { tone: Tone; badge?: string | undefined }>()
  for (const u of report.tables) {
    if (u.fullReads + u.indexReads === 0) continue
    tables.set(u.table, {
      tone: u.fullReads > u.indexReads ? 'scan' : 'index',
      badge: t.badge(u.fullReads, u.indexReads),
    })
  }
  return { tables, relations: new Map(), columns: new Map() }
}

/** Indexes never read since the counting began, leaving out those that keep rows unique: candidates, not verdicts. */
export const unusedIndexes = (report: TableUsageReport): IndexUsage[] =>
  report.indexes.filter((i) => i.reads === 0 && !i.unique)

import type { DdlOp } from '@tsmyadmin/shared'
import { useState } from 'react'
import { type DdlFlow, useDdlFlow } from '@/lib/ddl.ts'

/** A table whose statistics were taken again: the rows the plan expected of it before, and whether a run was put away. */
export interface StatsRefreshed {
  table: string
  before: number | null
  cleared: boolean
}

export interface StatsRefresh {
  flow: DdlFlow
  /** The last table whose statistics were taken again from here; null until then. */
  refreshed: StatsRefreshed | null
  /** When statistics were last taken again (0: not yet): what was read before (the tables' estimates) is read anew. */
  since: number
  /** Asks to take a table's statistics again (ANALYZE, through the preview): `before` is what the plan expects now. */
  refresh: (table: string, before: number | null) => void
}

/**
 * Taking a table's statistics again from a plan (`ANALYZE` / `ANALYZE TABLE`, previewed and confirmed as any DDL).
 * Done, the plan is read again (every query of the database is), and `onDone` puts away what was measured under the
 * old statistics: it returns whether there was such a run.
 */
export function useStatsRefresh(db: string, schema: string | undefined, onDone: () => boolean): StatsRefresh {
  const [asked, setAsked] = useState<{ table: string; before: number | null } | null>(null)
  const [refreshed, setRefreshed] = useState<StatsRefreshed | null>(null)
  const [since, setSince] = useState(0)
  const flow = useDdlFlow(db, schema, (op: DdlOp) => {
    if (op.op !== 'maintainTable' || !asked || op.table !== asked.table) return
    setRefreshed({ ...asked, cleared: onDone() })
    setSince(Date.now())
  })
  return {
    flow,
    refreshed,
    since,
    refresh: (table, before) => {
      setAsked({ table, before })
      flow.preview({ op: 'maintainTable', table, action: 'analyze' })
    },
  }
}

/** One database and what it holds: its tables, routines, triggers, events and snapshots, and running SQL in it (routes/databases.ts, snapshots.ts). */
import { queryOptions } from '@tanstack/react-query'
import type {
  DatabaseInfo,
  DdlOp,
  DdlPreviewResponse,
  DependencyReport,
  EventDetail,
  EventInfo,
  ExplainResult,
  QueryBuilderRequestInput,
  QueryBuilderResult,
  RelationDef,
  RoutineDefinition,
  RoutineDetail,
  RoutineInfo,
  RoutineKind,
  SnapshotDiff,
  SnapshotList,
  SnapshotRestorePreview,
  SnapshotRestoreResult,
  SqlRequest,
  StatementResult,
  TableInfo,
  TableUsageReport,
  TrackedTable,
  TriggerDetail,
  TriggerInfo,
} from '@tsmyadmin/shared'
import { api, enc, unwrap } from '../api.ts'
import { recordStatement } from '../debug-sql.ts'
import { schemaQuery } from './common.ts'

/** The queries the sidebar tree is drawn from: the databases, their schemas and their table lists. */
export const isDatabaseTreeQuery = (key: readonly unknown[]) =>
  ['databases', 'schemas', 'tables'].includes(String(key[0]))

export const databasesQuery = queryOptions({
  queryKey: ['databases'],
  queryFn: () => unwrap<DatabaseInfo[]>(api.databases.$get({ query: {} })),
})

/** The database list of the top page: without `counted` the server skips the size and table-count aggregates. */
export const databaseListQuery = (counted: boolean) =>
  queryOptions({
    queryKey: ['databases', counted ? 'counted' : 'plain'],
    queryFn: () => unwrap<DatabaseInfo[]>(api.databases.$get({ query: { stats: counted ? '1' : '0' } })),
  })

export const schemasQuery = (db: string) =>
  queryOptions({
    queryKey: ['schemas', db],
    queryFn: () => unwrap<string[]>(api.databases[':db'].schemas.$get({ param: { db: enc(db) } })),
  })

/**
 * How the query tab's choices join their tables (with the SQL), read for its presentation. Built from structure
 * alone, nothing run; the choices are the key, so a presentation never shows the plan of other choices.
 */
export const queryPlanQuery = (db: string, body: QueryBuilderRequestInput) =>
  queryOptions({
    queryKey: ['query-plan', db, JSON.stringify(body)],
    queryFn: () => unwrap<QueryBuilderResult>(api.databases[':db'].query.$post({ param: { db: enc(db) }, json: body })),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  })

export const tablesQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['tables', db, schema ?? ''],
    queryFn: () =>
      unwrap<TableInfo[]>(api.databases[':db'].tables.$get({ param: { db: enc(db) }, query: schemaQuery(schema) })),
  })

export const routineDefinitionQuery = (db: string, name: string, kind: RoutineKind, schema?: string) =>
  queryOptions({
    queryKey: ['routine-definition', db, schema ?? '', kind, name],
    queryFn: () =>
      unwrap<RoutineDefinition>(
        api.databases[':db'].routines[':name'].definition.$get({
          param: { db: enc(db), name: enc(name) },
          query: { ...schemaQuery(schema), kind },
        })
      ),
    staleTime: 60_000,
  })

export const foreignKeysQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['foreign-keys', db, schema ?? ''],
    queryFn: () =>
      unwrap<RelationDef[]>(
        api.databases[':db']['foreign-keys'].$get({ param: { db: enc(db) }, query: schemaQuery(schema) })
      ),
  })

/** The plan of one statement, estimated on the server. Asked each time it is shown: the data under it changes the plan. */
export const explainQuery = (db: string, schema: string | undefined, sql: string) =>
  queryOptions({
    queryKey: ['explain', db, schema ?? '', sql],
    queryFn: () =>
      unwrap<ExplainResult>(
        api.databases[':db'].explain.$post({ param: { db: enc(db) }, query: schemaQuery(schema), json: { sql } })
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

/**
 * The plan measured by running the statement (a read only, in a transaction rolled back, stopped after the time
 * limit): asked on a press, never on its own, so not a query that refetches.
 */
export const analyzePlan = (db: string, schema: string | undefined, sql: string, queryId?: string) =>
  unwrap<ExplainResult>(
    api.databases[':db'].explain.analyze.$post({
      param: { db: enc(db) },
      query: schemaQuery(schema),
      // With an id, `mutations.cancelSql` stops it.
      json: { sql, ...(queryId ? { queryId } : {}) },
    })
  )

/** How the tables are read, by the server's own counters. Asked each time it is turned on: the counts keep moving. */
export const tableUsageQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['usage', db, schema ?? ''],
    queryFn: () =>
      unwrap<TableUsageReport>(api.databases[':db'].usage.$get({ param: { db: enc(db) }, query: schemaQuery(schema) })),
    staleTime: 0,
  })

/** Read when "Edit" is pressed, never cached: the form must start from what the server holds now. */
export const routineDetailQuery = (db: string, name: string, kind: RoutineKind, schema?: string, parameters?: string) =>
  queryOptions({
    queryKey: ['routine-detail', db, schema ?? '', kind, name, parameters ?? ''],
    queryFn: () =>
      unwrap<RoutineDetail | null>(
        api.databases[':db'].routines[':name'].detail.$get({
          param: { db: enc(db), name: enc(name) },
          query: { ...schemaQuery(schema), kind, ...(parameters !== undefined ? { parameters } : {}) },
        })
      ),
    staleTime: 0,
  })

export const triggerDetailQuery = (db: string, table: string, name: string, schema?: string) =>
  queryOptions({
    queryKey: ['trigger-detail', db, schema ?? '', table, name],
    queryFn: () =>
      unwrap<TriggerDetail | null>(
        api.databases[':db'].triggers[':name'].detail.$get({
          param: { db: enc(db), name: enc(name) },
          query: { ...schemaQuery(schema), table },
        })
      ),
    staleTime: 0,
  })

export const eventDetailQuery = (db: string, name: string, schema?: string) =>
  queryOptions({
    queryKey: ['event-detail', db, schema ?? '', name],
    queryFn: () =>
      unwrap<EventDetail | null>(
        api.databases[':db'].events[':name'].detail.$get({
          param: { db: enc(db), name: enc(name) },
          query: schemaQuery(schema),
        })
      ),
    staleTime: 0,
  })

/** What the views and routines depend on, for the dependency diagram and a table's structure. */
export const dependenciesQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['dependencies', db, schema ?? ''],
    queryFn: () =>
      unwrap<DependencyReport>(
        api.databases[':db'].dependencies.$get({ param: { db: enc(db) }, query: schemaQuery(schema) })
      ),
  })

export const routinesQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['routines', db, schema ?? ''],
    queryFn: () =>
      unwrap<RoutineInfo[]>(api.databases[':db'].routines.$get({ param: { db: enc(db) }, query: schemaQuery(schema) })),
  })

export const triggersQuery = (db: string, schema?: string, table?: string) =>
  queryOptions({
    queryKey: ['triggers', db, schema ?? '', table ?? ''],
    queryFn: () =>
      unwrap<TriggerInfo[]>(
        api.databases[':db'].triggers.$get({
          param: { db: enc(db) },
          query: { ...schemaQuery(schema), ...(table ? { table } : {}) },
        })
      ),
  })

export const eventsQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['events', db, schema ?? ''],
    queryFn: () =>
      unwrap<EventInfo[]>(api.databases[':db'].events.$get({ param: { db: enc(db) }, query: schemaQuery(schema) })),
  })

/** The snapshots this account holds of a database / schema. */
export const snapshotsQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['snapshots', db, schema ?? ''],
    queryFn: () =>
      unwrap<SnapshotList>(api.databases[':db'].snapshots.$get({ param: { db: enc(db) }, query: schemaQuery(schema) })),
  })

/** The schema now compared with one snapshot: read afresh every time it is opened (a migration may have run since). */
export const snapshotDiffQuery = (db: string, schema: string | undefined, id: string) =>
  queryOptions({
    queryKey: ['snapshots', db, schema ?? '', 'diff', id],
    queryFn: () =>
      unwrap<SnapshotDiff>(
        api.databases[':db'].snapshots[':id'].diff.$get({
          param: { db: enc(db), id: enc(id) },
          query: schemaQuery(schema),
        })
      ),
    staleTime: 0,
    gcTime: 0,
  })

/** The tracked tables of a database / schema. */
export const databaseTrackingQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['tracking', db, schema ?? ''],
    queryFn: () =>
      unwrap<TrackedTable[]>(
        api.databases[':db'].tracking.$get({ param: { db: enc(db) }, query: schemaQuery(schema) })
      ),
  })

export const databaseMutations = {
  takeSnapshot: (db: string, schema: string | undefined, name: string) =>
    unwrap<SnapshotList>(
      api.databases[':db'].snapshots.$post({ param: { db: enc(db) }, query: schemaQuery(schema), json: { name } })
    ),
  deleteSnapshot: (db: string, schema: string | undefined, id: string) =>
    unwrap<SnapshotList>(
      api.databases[':db'].snapshots[':id'].$delete({ param: { db: enc(db), id: enc(id) }, query: schemaQuery(schema) })
    ),
  previewRestore: (db: string, schema: string | undefined, id: string) =>
    unwrap<SnapshotRestorePreview>(
      api.databases[':db'].snapshots[':id'].restore.preview.$get({
        param: { db: enc(db), id: enc(id) },
        query: schemaQuery(schema),
      })
    ),
  restoreSnapshot: (db: string, schema: string | undefined, id: string) =>
    unwrap<SnapshotRestoreResult>(
      api.databases[':db'].snapshots[':id'].restore.$post({
        param: { db: enc(db), id: enc(id) },
        query: schemaQuery(schema),
      })
    ),
  executeSql: (
    db: string,
    body: Omit<SqlRequest, 'maxRows' | 'timeoutMs' | 'stopOnError' | 'profile'> & Partial<SqlRequest>
  ) =>
    unwrap<StatementResult[]>(api.databases[':db'].sql.$post({ param: { db: enc(db) }, json: body })).then(
      (results) => {
        for (const r of results) recordStatement(r)
        return results
      }
    ),
  cancelSql: (db: string, queryId: string) =>
    unwrap<{ cancelled: boolean }>(
      api.databases[':db'].sql.cancel.$post({ param: { db: enc(db) }, json: { queryId } })
    ),
  previewDdl: (db: string, schema: string | undefined, op: DdlOp) =>
    unwrap<DdlPreviewResponse>(
      api.databases[':db'].ddl.preview.$post({ param: { db: enc(db) }, json: { ...schemaQuery(schema), op } })
    ),
  buildQuery: (db: string, body: QueryBuilderRequestInput) =>
    unwrap<QueryBuilderResult>(api.databases[':db'].query.$post({ param: { db: enc(db) }, json: body })),
}

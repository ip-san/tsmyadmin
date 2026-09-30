/** One database and what it holds: its tables, routines, triggers, events and snapshots, and running SQL in it (routes/databases.ts, snapshots.ts). */
import { queryOptions } from '@tanstack/react-query'
import type {
  DatabaseInfo,
  DdlOp,
  DdlPreviewResponse,
  EventDetail,
  EventInfo,
  QueryBuilderRequestInput,
  QueryBuilderResult,
  RelationDef,
  RoutineDefinition,
  RoutineDetail,
  RoutineInfo,
  RoutineKind,
  SnapshotList,
  SnapshotRestorePreview,
  SnapshotRestoreResult,
  SqlRequest,
  StatementResult,
  TableInfo,
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

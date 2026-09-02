import { queryOptions } from '@tanstack/react-query'
import type {
  BrowseOptions,
  BrowseResult,
  DdlOp,
  DdlPreviewResponse,
  EventInfo,
  KeyValue,
  ProcessInfo,
  RoutineDefinition,
  RoutineInfo,
  RoutineKind,
  RowKey,
  RowValues,
  ServerInfo,
  ServerPreset,
  SessionState,
  SqlRequest,
  StatementResult,
  TableInfo,
  TableSchema,
  TriggerInfo,
  UserGrants,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import { buildBrowseQuery } from '@tsmyadmin/shared'
import { api, enc, isApiError, unwrap } from './api.ts'

export interface TableRef {
  db: string
  schema?: string | undefined
  table: string
}

const schemaQuery = (schema?: string) => (schema ? { schema } : {})

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async (): Promise<SessionState | null> => {
    try {
      return await unwrap<SessionState>(api.session.$get())
    } catch (err) {
      if (isApiError(err, 'UNAUTHENTICATED')) return null
      throw err
    }
  },
  staleTime: 60_000,
})

export const serversQuery = queryOptions({
  queryKey: ['servers'],
  queryFn: () => unwrap<ServerPreset[]>(api.servers.$get()),
  staleTime: Number.POSITIVE_INFINITY,
})

export const databasesQuery = queryOptions({
  queryKey: ['databases'],
  queryFn: () => unwrap<{ name: string }[]>(api.databases.$get()),
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

/** CREATE TABLE / VIEW statements as the server prints (MySQL) or reconstructs (PostgreSQL) them. */
export const createStatementQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['create-statement', ref.db, ref.schema ?? '', ref.table],
    queryFn: async (): Promise<RoutineDefinition> => {
      const r = await unwrap<DdlPreviewResponse>(
        api.databases[':db'].tables[':table'].create.$get({
          param: { db: enc(ref.db), table: enc(ref.table) },
          query: schemaQuery(ref.schema),
        })
      )
      return { definition: r.sql.map((x) => `${x};`).join('\n\n') }
    },
    staleTime: 60_000,
  })

export const structureQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['structure', ref.db, ref.schema ?? '', ref.table],
    queryFn: () =>
      unwrap<TableSchema>(
        api.databases[':db'].tables[':table'].structure.$get({
          param: { db: enc(ref.db), table: enc(ref.table) },
          query: schemaQuery(ref.schema),
        })
      ),
  })

/** Key prefix shared by every rows page of one table (invalidate this after a mutation, not the whole database). */
export const rowsKey = (ref: TableRef) => ['rows', ref.db, ref.schema ?? '', ref.table] as const

export const rowsQuery = (ref: TableRef, options: BrowseOptions) =>
  queryOptions({
    queryKey: [...rowsKey(ref), options],
    queryFn: () =>
      unwrap<BrowseResult>(
        api.databases[':db'].tables[':table'].rows.$get({
          param: { db: enc(ref.db), table: enc(ref.table) },
          query: buildBrowseQuery(options, ref.schema),
        })
      ),
    placeholderData: (prev) => prev,
  })

export const usersQuery = queryOptions({
  queryKey: ['users'],
  queryFn: () => unwrap<UserInfo[]>(api.users.$get()),
})

export const grantsQuery = (user: UserRef) =>
  queryOptions({
    queryKey: ['users', 'grants', user.name, user.host ?? ''],
    queryFn: () => unwrap<UserGrants>(api.users.grants.$get({ query: user })),
  })

export const serverInfoQuery = queryOptions({
  queryKey: ['server', 'info'],
  queryFn: () => unwrap<ServerInfo>(api.server.info.$get()),
})
export const variablesQuery = queryOptions({
  queryKey: ['server', 'variables'],
  queryFn: () => unwrap<KeyValue[]>(api.server.variables.$get()),
})
export const statusQuery = queryOptions({
  queryKey: ['server', 'status'],
  queryFn: () => unwrap<KeyValue[]>(api.server.status.$get()),
  staleTime: 0,
})
export const processesQuery = queryOptions({
  queryKey: ['server', 'processes'],
  queryFn: () => unwrap<ProcessInfo[]>(api.server.processes.$get()),
  staleTime: 0,
})

export const mutations = {
  login: (body: Parameters<typeof api.session.$post>[0]['json']) =>
    unwrap<SessionState>(api.session.$post({ json: body })),
  logout: () => unwrap<{ ok: boolean }>(api.session.$delete()),
  insertRow: (ref: TableRef, values: RowValues) =>
    unwrap<{ affectedRows: number }>(
      api.databases[':db'].tables[':table'].rows.$post({
        param: { db: enc(ref.db), table: enc(ref.table) },
        query: schemaQuery(ref.schema),
        json: { values },
      })
    ),
  updateRow: (ref: TableRef, key: RowKey, values: RowValues) =>
    unwrap<{ affectedRows: number }>(
      api.databases[':db'].tables[':table'].rows.$patch({
        param: { db: enc(ref.db), table: enc(ref.table) },
        query: schemaQuery(ref.schema),
        json: { key, values },
      })
    ),
  deleteRows: (ref: TableRef, keys: RowKey[]) =>
    unwrap<{ affectedRows: number }>(
      api.databases[':db'].tables[':table'].rows.$delete({
        param: { db: enc(ref.db), table: enc(ref.table) },
        query: schemaQuery(ref.schema),
        json: { keys },
      })
    ),
  executeSql: (db: string, body: Omit<SqlRequest, 'maxRows' | 'timeoutMs' | 'stopOnError'> & Partial<SqlRequest>) =>
    unwrap<StatementResult[]>(api.databases[':db'].sql.$post({ param: { db: enc(db) }, json: body })),
  cancelSql: (db: string, queryId: string) =>
    unwrap<{ cancelled: boolean }>(
      api.databases[':db'].sql.cancel.$post({ param: { db: enc(db) }, json: { queryId } })
    ),
  killProcess: (id: string) =>
    unwrap<{ ok: boolean }>(api.server.processes[':id'].kill.$post({ param: { id: enc(id) } })),
  previewDdl: (db: string, schema: string | undefined, op: DdlOp) =>
    unwrap<DdlPreviewResponse>(
      api.databases[':db'].ddl.preview.$post({ param: { db: enc(db) }, json: { ...schemaQuery(schema), op } })
    ),
}

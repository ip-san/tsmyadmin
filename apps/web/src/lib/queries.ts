import { queryOptions } from '@tanstack/react-query'
import type {
  BrowseOptions,
  BrowseResult,
  DdlOp,
  KeyValue,
  ProcessInfo,
  RowKey,
  RowValues,
  ServerInfo,
  SessionInfo,
  SqlRequest,
  StatementResult,
  TableInfo,
  TableSchema,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import { buildBrowseQuery } from '@tsmyadmin/shared'
import { api, isApiError, unwrap } from './api.ts'

export interface TableRef {
  db: string
  schema?: string | undefined
  table: string
}

const schemaQuery = (schema?: string) => (schema ? { schema } : {})

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async (): Promise<SessionInfo | null> => {
    try {
      return await unwrap<SessionInfo>(api.session.$get())
    } catch (err) {
      if (isApiError(err, 'UNAUTHENTICATED')) return null
      throw err
    }
  },
  staleTime: 60_000,
})

export const databasesQuery = queryOptions({
  queryKey: ['databases'],
  queryFn: () => unwrap<{ name: string }[]>(api.databases.$get()),
})

export const schemasQuery = (db: string) =>
  queryOptions({
    queryKey: ['schemas', db],
    queryFn: () => unwrap<string[]>(api.databases[':db'].schemas.$get({ param: { db } })),
  })

export const tablesQuery = (db: string, schema?: string) =>
  queryOptions({
    queryKey: ['tables', db, schema ?? ''],
    queryFn: () => unwrap<TableInfo[]>(api.databases[':db'].tables.$get({ param: { db }, query: schemaQuery(schema) })),
  })

export const structureQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['structure', ref.db, ref.schema ?? '', ref.table],
    queryFn: () =>
      unwrap<TableSchema>(
        api.databases[':db'].tables[':table'].structure.$get({
          param: { db: ref.db, table: ref.table },
          query: schemaQuery(ref.schema),
        })
      ),
  })

export const rowsQuery = (ref: TableRef, options: BrowseOptions) =>
  queryOptions({
    queryKey: ['rows', ref.db, ref.schema ?? '', ref.table, options],
    queryFn: () =>
      unwrap<BrowseResult>(
        api.databases[':db'].tables[':table'].rows.$get({
          param: { db: ref.db, table: ref.table },
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
    queryFn: () => unwrap<{ statements: string[] }>(api.users.grants.$get({ query: user })),
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
    unwrap<SessionInfo>(api.session.$post({ json: body })),
  logout: () => unwrap<{ ok: boolean }>(api.session.$delete()),
  insertRow: (ref: TableRef, values: RowValues) =>
    unwrap<{ affectedRows: number }>(
      api.databases[':db'].tables[':table'].rows.$post({
        param: { db: ref.db, table: ref.table },
        query: schemaQuery(ref.schema),
        json: { values },
      })
    ),
  updateRow: (ref: TableRef, key: RowKey, values: RowValues) =>
    unwrap<{ affectedRows: number }>(
      api.databases[':db'].tables[':table'].rows.$patch({
        param: { db: ref.db, table: ref.table },
        query: schemaQuery(ref.schema),
        json: { key, values },
      })
    ),
  deleteRows: (ref: TableRef, keys: RowKey[]) =>
    unwrap<{ affectedRows: number }>(
      api.databases[':db'].tables[':table'].rows.$delete({
        param: { db: ref.db, table: ref.table },
        query: schemaQuery(ref.schema),
        json: { keys },
      })
    ),
  executeSql: (db: string, body: Omit<SqlRequest, 'maxRows' | 'timeoutMs' | 'stopOnError'> & Partial<SqlRequest>) =>
    unwrap<StatementResult[]>(api.databases[':db'].sql.$post({ param: { db }, json: body })),
  cancelSql: (db: string, queryId: string) =>
    unwrap<{ cancelled: boolean }>(api.databases[':db'].sql.cancel.$post({ param: { db }, json: { queryId } })),
  killProcess: (id: string) => unwrap<{ ok: boolean }>(api.server.processes[':id'].kill.$post({ param: { id } })),
  previewDdl: (db: string, schema: string | undefined, op: DdlOp) =>
    unwrap<{ sql: string[] }>(
      api.databases[':db'].ddl.preview.$post({ param: { db }, json: { ...schemaQuery(schema), op } })
    ),
}

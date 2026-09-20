import { queryOptions } from '@tanstack/react-query'
import type {
  AccountSecondFactors,
  BrowseOptions,
  BrowseResult,
  CentralColumn,
  CentralColumnBody,
  ColumnTransform,
  ColumnTransformBody,
  DatabaseInfo,
  DdlOp,
  DdlPreviewResponse,
  DesignerPage,
  DiagnosticKind,
  DiagnosticReport,
  DistinctValues,
  EventDetail,
  EventInfo,
  ExportTemplate,
  HistoryEntry,
  InsertPreview,
  KeyValue,
  KillMode,
  MyGroupTabs,
  Partitioning,
  PasskeyChallenge,
  PasskeyRegistration,
  PasskeyResponse,
  ProcessInfo,
  QueryBuilderRequestInput,
  QueryBuilderResult,
  QueryTemplate,
  ReferenceCheck,
  RelationDef,
  ReplicationInfo,
  RoutineDefinition,
  RoutineDetail,
  RoutineInfo,
  RoutineKind,
  RowCount,
  RowKey,
  RowValues,
  SaveDesignerPageRequest,
  SavedQuery,
  SaveExportTemplateRequest,
  SaveQueryTemplateRequest,
  SearchOptions,
  SecondFactorProof,
  SecondFactorSetup,
  SecondFactorStatus,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
  ServerPreset,
  SessionState,
  SharedQuery,
  SqlHistory,
  SqlRequest,
  StatementResult,
  TableInfo,
  TableSchema,
  TableSearchResult,
  TableStats,
  TrackedTable,
  TrackingState,
  TrackKind,
  TriggerDetail,
  TriggerInfo,
  UserGrants,
  UserGroup,
  UserGroupBody,
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

/** Bookmarks stored with the account; only fetched where the session says the server keeps them. */
export const listSavedQueries = () => unwrap<SavedQuery[]>(api['saved-queries'].$get())
export const savedQueriesQuery = queryOptions({ queryKey: ['saved-queries'], queryFn: listSavedQueries })
export const listSharedQueries = () => unwrap<SharedQuery[]>(api['shared-queries'].$get())
export const sqlHistoryQuery = queryOptions({
  queryKey: ['sql-history'],
  queryFn: () => unwrap<SqlHistory>(api['sql-history'].$get()),
})

/** Saved export choices, per account; the list is filtered to the current database in the export page. */
export const secondFactorQuery = queryOptions({
  queryKey: ['second-factor'],
  queryFn: () => unwrap<SecondFactorStatus>(api['second-factor'].$get()),
})

/** Other accounts' second factors this one may reset (empty for an account without that authority). */
export const accountSecondFactorsQuery = queryOptions({
  queryKey: ['second-factor', 'accounts'],
  queryFn: () => unwrap<AccountSecondFactors>(api['second-factor'].accounts.$get()),
})

export const listQueryTemplates = () => unwrap<QueryTemplate[]>(api['query-templates'].$get())
export const queryTemplatesQuery = queryOptions({ queryKey: ['query-templates'], queryFn: listQueryTemplates })
export const listDesignerPages = () => unwrap<DesignerPage[]>(api['designer-pages'].$get())
export const designerPagesQuery = queryOptions({ queryKey: ['designer-pages'], queryFn: listDesignerPages })
export const listExportTemplates = () => unwrap<ExportTemplate[]>(api['export-templates'].$get())
export const exportTemplatesQuery = queryOptions({ queryKey: ['export-templates'], queryFn: listExportTemplates })
export const listCentralColumns = () => unwrap<CentralColumn[]>(api['central-columns'].$get())
export const centralColumnsQuery = queryOptions({ queryKey: ['central-columns'], queryFn: listCentralColumns })
/** What the signed-in account's user groups hide; asked once per login (a group change is rare). */
export const myGroupTabsQuery = queryOptions({
  queryKey: ['user-groups', 'mine'],
  queryFn: () => unwrap<MyGroupTabs>(api['user-groups'].mine.$get()),
  staleTime: Number.POSITIVE_INFINITY,
})
export const userGroupsQuery = queryOptions({
  queryKey: ['user-groups', 'all'],
  queryFn: () => unwrap<UserGroup[]>(api['user-groups'].$get()),
})
export const listColumnTransforms = () => unwrap<ColumnTransform[]>(api['column-transforms'].$get())

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

/** CREATE TABLE / VIEW statements as the server prints (MySQL) or reconstructs (PostgreSQL) them. */
const trackingRequest = (ref: TableRef) => ({
  param: { db: enc(ref.db), table: enc(ref.table) },
  query: schemaQuery(ref.schema),
})
export const trackingQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['tracking', ref.db, ref.schema ?? '', ref.table],
    queryFn: () => unwrap<TrackingState>(api.databases[':db'].tables[':table'].tracking.$get(trackingRequest(ref))),
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

/** An exact COUNT(*), run only when asked for. */
export const rowCountQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['structure', ref.db, ref.schema ?? '', ref.table, 'count'],
    queryFn: async () =>
      (
        await unwrap<RowCount>(
          api.databases[':db'].tables[':table'].count.$get({
            param: { db: enc(ref.db), table: enc(ref.table) },
            query: schemaQuery(ref.schema),
          })
        )
      ).count,
  })

/** A table's partitioning; under the structure key so a DDL that refreshes the structure refreshes it too. */
export const partitionsQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['structure', ref.db, ref.schema ?? '', ref.table, 'partitions'],
    queryFn: () =>
      unwrap<Partitioning>(
        api.databases[':db'].tables[':table'].partitions.$get({
          param: { db: enc(ref.db), table: enc(ref.table) },
          query: schemaQuery(ref.schema),
        })
      ),
  })

/** Space and row statistics; under the structure key, so whatever refreshes the structure refreshes these too. */
export const tableStatsQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['structure', ref.db, ref.schema ?? '', ref.table, 'stats'],
    queryFn: () =>
      unwrap<TableStats>(
        api.databases[':db'].tables[':table'].stats.$get({
          param: { db: enc(ref.db), table: enc(ref.table) },
          query: schemaQuery(ref.schema),
        })
      ),
  })

/** Key prefix shared by every rows page of one table (invalidate this after a mutation, not the whole database). */
export const rowsKey = (ref: TableRef) => ['rows', ref.db, ref.schema ?? '', ref.table] as const

export const referenceCheckQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['references', ref.db, ref.schema ?? '', ref.table],
    queryFn: () =>
      unwrap<ReferenceCheck[]>(
        api.databases[':db'].tables[':table'].references.$get({
          param: { db: enc(ref.db), table: enc(ref.table) },
          query: schemaQuery(ref.schema),
        })
      ),
    staleTime: 0,
  })

export const distinctValuesQuery = (ref: TableRef, column: string) =>
  queryOptions({
    queryKey: ['distinct', ref.db, ref.schema ?? '', ref.table, column],
    queryFn: () =>
      unwrap<DistinctValues>(
        api.databases[':db'].tables[':table'].columns[':column'].distinct.$get({
          param: { db: enc(ref.db), table: enc(ref.table), column: enc(column) },
          query: schemaQuery(ref.schema),
        })
      ),
    staleTime: 0,
  })

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

/** `ns` selects the database whose ACLs are listed (PostgreSQL privileges are per database). */
export const grantsQuery = (user: UserRef, ns?: { database: string; schema?: string | undefined }) =>
  queryOptions({
    queryKey: ['users', 'grants', user.name, user.host ?? '', ns?.database ?? '', ns?.schema ?? ''],
    queryFn: () =>
      unwrap<UserGrants>(
        api.users.grants.$get({
          query: { ...user, ...(ns ? { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) } : {}) },
        })
      ),
  })

export const serverInfoQuery = queryOptions({
  queryKey: ['server', 'info'],
  queryFn: () => unwrap<ServerInfo>(api.server.info.$get()),
})
export const variablesQuery = queryOptions({
  queryKey: ['server', 'variables'],
  queryFn: () => unwrap<KeyValue[]>(api.server.variables.$get()),
})
/** Collations, engines (PostgreSQL: access methods) or plugins (PostgreSQL: extensions). */
export const serverCatalogQuery = (kind: ServerCatalogKind) =>
  queryOptions({
    queryKey: ['server', 'catalog', kind],
    queryFn: () => unwrap<ServerCatalog>(api.server.catalog[':kind'].$get({ param: { kind } })),
    staleTime: Number.POSITIVE_INFINITY,
  })
/** Logged statements, InnoDB status or binary log events; `file` picks the binary log. */
export const diagnosticsQuery = (kind: DiagnosticKind, file?: string) =>
  queryOptions({
    queryKey: ['server', 'diagnostics', kind, file ?? ''],
    queryFn: () =>
      unwrap<DiagnosticReport>(
        api.server.diagnostics[':kind'].$get({ param: { kind }, query: file === undefined ? {} : { file } })
      ),
    staleTime: 0,
  })
export const replicationQuery = queryOptions({
  queryKey: ['server', 'replication'],
  queryFn: () => unwrap<ReplicationInfo>(api.server.replication.$get()),
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

/** One table of the database-wide search. The page calls these one at a time, so it can stop between tables. */
export const searchTable = (ref: TableRef, term: string, options: SearchOptions = {}) =>
  unwrap<TableSearchResult>(
    api.databases[':db'].tables[':table'].search.$get({
      param: { db: enc(ref.db), table: enc(ref.table) },
      query: {
        q: term,
        ...schemaQuery(ref.schema),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.column ? { column: options.column } : {}),
      },
    })
  )

export const mutations = {
  login: (body: Parameters<typeof api.session.$post>[0]['json']) =>
    unwrap<SessionState>(api.session.$post({ json: body })),
  logout: () => unwrap<{ ok: boolean }>(api.session.$delete()),
  beginSecondFactor: (proof?: SecondFactorProof) =>
    unwrap<SecondFactorSetup>(api['second-factor'].begin.$post({ json: proof ?? {} })),
  confirmSecondFactor: (code: string) =>
    unwrap<SecondFactorStatus>(api['second-factor'].confirm.$post({ json: { code } })),
  disableSecondFactor: (proof: SecondFactorProof) =>
    unwrap<SecondFactorStatus>(api['second-factor'].$delete({ json: proof })),
  removeTotp: (proof: SecondFactorProof) =>
    unwrap<SecondFactorStatus>(api['second-factor'].totp.$delete({ json: proof })),
  passkeyChallenge: () => unwrap<PasskeyChallenge>(api['second-factor'].passkeys.challenge.$post()),
  beginPasskey: (proof?: SecondFactorProof) =>
    unwrap<PasskeyRegistration>(api['second-factor'].passkeys.begin.$post({ json: proof ?? {} })),
  confirmPasskey: (response: PasskeyResponse) =>
    unwrap<SecondFactorStatus>(api['second-factor'].passkeys.confirm.$post({ json: { response } })),
  removePasskey: (id: string, proof: SecondFactorProof) =>
    unwrap<SecondFactorStatus>(api['second-factor'].passkeys[':id'].$delete({ param: { id: enc(id) }, json: proof })),
  resetSecondFactor: (user: string) =>
    unwrap<AccountSecondFactors>(api['second-factor'].accounts.reset.$post({ json: { user } })),
  insertRow: (ref: TableRef, values: RowValues, ignore = false) =>
    unwrap<{ affectedRows: number }>(
      api.databases[':db'].tables[':table'].rows.$post({
        param: { db: enc(ref.db), table: enc(ref.table) },
        query: schemaQuery(ref.schema),
        json: { values, ...(ignore ? { ignore: true } : {}) },
      })
    ),
  previewInsert: (ref: TableRef, values: RowValues, ignore = false) =>
    unwrap<InsertPreview>(
      api.databases[':db'].tables[':table'].rows.preview.$post({
        param: { db: enc(ref.db), table: enc(ref.table) },
        query: schemaQuery(ref.schema),
        json: { values, ...(ignore ? { ignore: true } : {}) },
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
  executeSql: (
    db: string,
    body: Omit<SqlRequest, 'maxRows' | 'timeoutMs' | 'stopOnError' | 'profile'> & Partial<SqlRequest>
  ) => unwrap<StatementResult[]>(api.databases[':db'].sql.$post({ param: { db: enc(db) }, json: body })),
  cancelSql: (db: string, queryId: string) =>
    unwrap<{ cancelled: boolean }>(
      api.databases[':db'].sql.cancel.$post({ param: { db: enc(db) }, json: { queryId } })
    ),
  saveQuery: (name: string, sql: string) => unwrap<SavedQuery[]>(api['saved-queries'].$post({ json: { name, sql } })),
  deleteSavedQuery: (id: string) => unwrap<SavedQuery[]>(api['saved-queries'][':id'].$delete({ param: { id } })),
  saveSharedQuery: (name: string, sql: string) =>
    unwrap<SharedQuery[]>(api['shared-queries'].$post({ json: { name, sql } })),
  deleteSharedQuery: (id: string) => unwrap<SharedQuery[]>(api['shared-queries'][':id'].$delete({ param: { id } })),
  addSqlHistory: (entry: HistoryEntry, limit: number) =>
    unwrap<SqlHistory>(api['sql-history'].$post({ json: { entry, limit } }, { init: { keepalive: true } })),
  clearSqlHistory: () => unwrap<SqlHistory>(api['sql-history'].$delete()),
  killProcess: (id: string, mode: KillMode) =>
    unwrap<{ ok: boolean }>(api.server.processes[':id'].kill.$post({ param: { id: enc(id) }, query: { mode } })),
  previewDdl: (db: string, schema: string | undefined, op: DdlOp) =>
    unwrap<DdlPreviewResponse>(
      api.databases[':db'].ddl.preview.$post({ param: { db: enc(db) }, json: { ...schemaQuery(schema), op } })
    ),
  saveQueryTemplate: (body: SaveQueryTemplateRequest) =>
    unwrap<QueryTemplate[]>(api['query-templates'].$post({ json: body })),
  deleteQueryTemplate: (id: string) =>
    unwrap<QueryTemplate[]>(api['query-templates'][':id'].$delete({ param: { id } })),
  saveDesignerPage: (body: SaveDesignerPageRequest) =>
    unwrap<DesignerPage[]>(api['designer-pages'].$post({ json: body })),
  deleteDesignerPage: (id: string) => unwrap<DesignerPage[]>(api['designer-pages'][':id'].$delete({ param: { id } })),
  saveExportTemplate: (body: SaveExportTemplateRequest) =>
    unwrap<ExportTemplate[]>(api['export-templates'].$post({ json: body })),
  deleteExportTemplate: (id: string) =>
    unwrap<ExportTemplate[]>(api['export-templates'][':id'].$delete({ param: { id } })),
  saveCentralColumn: (body: CentralColumnBody) => unwrap<CentralColumn[]>(api['central-columns'].$post({ json: body })),
  deleteCentralColumn: (id: string) =>
    unwrap<CentralColumn[]>(api['central-columns'][':id'].$delete({ param: { id } })),
  recordVersion: (ref: TableRef) =>
    unwrap<TrackingState>(api.databases[':db'].tables[':table'].tracking.$post(trackingRequest(ref))),
  setTrackingKinds: (ref: TableRef, kinds: TrackKind[]) =>
    unwrap<TrackingState>(
      api.databases[':db'].tables[':table'].tracking.kinds.$put({ ...trackingRequest(ref), json: { kinds } })
    ),
  deleteTrackedVersion: (ref: TableRef, version: number) =>
    unwrap<TrackingState>(
      api.databases[':db'].tables[':table'].tracking[':version'].$delete({
        ...trackingRequest(ref),
        param: { ...trackingRequest(ref).param, version: String(version) },
      })
    ),
  stopTracking: (ref: TableRef) =>
    unwrap<TrackingState>(api.databases[':db'].tables[':table'].tracking.$delete(trackingRequest(ref))),
  saveUserGroup: (body: UserGroupBody) => unwrap<UserGroup[]>(api['user-groups'].$post({ json: body })),
  deleteUserGroup: (id: string) => unwrap<UserGroup[]>(api['user-groups'][':id'].$delete({ param: { id } })),
  saveColumnTransform: (body: ColumnTransformBody) =>
    unwrap<ColumnTransform[]>(api['column-transforms'].$post({ json: body })),
  deleteColumnTransform: (id: string) =>
    unwrap<ColumnTransform[]>(api['column-transforms'][':id'].$delete({ param: { id } })),
  buildQuery: (db: string, body: QueryBuilderRequestInput) =>
    unwrap<QueryBuilderResult>(api.databases[':db'].query.$post({ param: { db: enc(db) }, json: body })),
}

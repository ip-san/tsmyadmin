/** One table: structure, rows, statistics, references, tracking, and the row writes (routes/databases.ts, tracking.ts). */
import { queryOptions } from '@tanstack/react-query'
import type {
  BrowseOptions,
  BrowseResult,
  DdlPreviewResponse,
  DistinctValues,
  InsertPreview,
  Partitioning,
  ReferenceCheck,
  RoutineDefinition,
  RowCount,
  RowKey,
  RowValues,
  SearchOptions,
  TableSchema,
  TableSearchResult,
  TableStats,
  TrackingState,
  TrackKind,
} from '@tsmyadmin/shared'
import { buildBrowseQuery } from '@tsmyadmin/shared'
import { api, enc, unwrap } from '../api.ts'
import { recordSql } from '../debug-sql.ts'
import { schemaQuery, type TableRef } from './common.ts'

const trackingRequest = (ref: TableRef) => ({
  param: { db: enc(ref.db), table: enc(ref.table) },
  query: schemaQuery(ref.schema),
})

export const trackingQuery = (ref: TableRef) =>
  queryOptions({
    queryKey: ['tracking', ref.db, ref.schema ?? '', ref.table],
    queryFn: () => unwrap<TrackingState>(api.databases[':db'].tables[':table'].tracking.$get(trackingRequest(ref))),
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
    queryFn: async () => {
      const started = performance.now()
      const page = await unwrap<BrowseResult>(
        api.databases[':db'].tables[':table'].rows.$get({
          param: { db: enc(ref.db), table: enc(ref.table) },
          query: buildBrowseQuery(options, ref.schema),
        })
      )
      recordSql(page.statement.sql, Math.round(performance.now() - started), true, page.statement.literal)
      return page
    },
    placeholderData: (prev) => prev,
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

export const tableMutations = {
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
}

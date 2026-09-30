/** The server itself and its accounts: info, variables, status, processes, replication, users (routes/server.ts, users.ts). */
import { queryOptions } from '@tanstack/react-query'
import type {
  DiagnosticKind,
  DiagnosticReport,
  KeyValue,
  KillMode,
  ProcessInfo,
  ReplicationInfo,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
  UserGrants,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import { api, enc, unwrap } from '../api.ts'

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

/** The statements that ran since `since` (a logged time; none: the latest). Not cached: every read is a fresh one. */
export const recentStatementsQuery = (since: () => string | undefined) =>
  queryOptions({
    queryKey: ['server', 'diagnostics', 'recentStatements'],
    queryFn: () => {
      const from = since()
      return unwrap<DiagnosticReport>(
        api.server.diagnostics[':kind'].$get({
          param: { kind: 'recentStatements' },
          query: from === undefined ? {} : { since: from },
        })
      )
    },
    staleTime: 0,
    gcTime: 0,
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

export const serverMutations = {
  killProcess: (id: string, mode: KillMode) =>
    unwrap<{ ok: boolean }>(api.server.processes[':id'].kill.$post({ param: { id: enc(id) }, query: { mode } })),
}

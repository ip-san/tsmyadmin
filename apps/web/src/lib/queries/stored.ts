/** What the server stores for the account or the server: saved queries, templates, pages, user groups, history (routes/session.ts, stored.ts, sql-lists.ts, user-groups.ts). */
import { queryOptions } from '@tanstack/react-query'
import type {
  CentralColumn,
  CentralColumnBody,
  ColumnTransform,
  ColumnTransformBody,
  DesignerPage,
  ExportTemplate,
  HistoryEntry,
  MyGroupTabs,
  QueryTemplate,
  SaveDesignerPageRequest,
  SavedQuery,
  SaveExportTemplateRequest,
  SaveQueryTemplateRequest,
  SharedQuery,
  SqlHistory,
  UserGroup,
  UserGroupBody,
} from '@tsmyadmin/shared'
import { api, unwrap } from '../api.ts'

/** Bookmarks stored with the account; only fetched where the session says the server keeps them. */
export const listSavedQueries = () => unwrap<SavedQuery[]>(api['saved-queries'].$get())

export const savedQueriesQuery = queryOptions({ queryKey: ['saved-queries'], queryFn: listSavedQueries })

export const listSharedQueries = () => unwrap<SharedQuery[]>(api['shared-queries'].$get())
export const sharedQueriesQuery = queryOptions({ queryKey: ['shared-queries'], queryFn: listSharedQueries })

export const sqlHistoryQuery = queryOptions({
  queryKey: ['sql-history'],
  queryFn: () => unwrap<SqlHistory>(api['sql-history'].$get()),
})

export const listQueryTemplates = () => unwrap<QueryTemplate[]>(api['query-templates'].$get())

export const queryTemplatesQuery = queryOptions({ queryKey: ['query-templates'], queryFn: listQueryTemplates })

export const listDesignerPages = () => unwrap<DesignerPage[]>(api['designer-pages'].$get())

export const designerPagesQuery = queryOptions({ queryKey: ['designer-pages'], queryFn: listDesignerPages })

export const listExportTemplates = () => unwrap<ExportTemplate[]>(api['export-templates'].$get())

/** Saved export choices, per account; the list is filtered to the current database in the export page. */
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

/** The key of the column transformations list; the screen keeps them in another shape, so only the key is shared. */
export const columnTransformsKey = ['column-transforms'] as const
export const listColumnTransforms = () => unwrap<ColumnTransform[]>(api['column-transforms'].$get())

export const storedMutations = {
  saveQuery: (name: string, sql: string) => unwrap<SavedQuery[]>(api['saved-queries'].$post({ json: { name, sql } })),
  deleteSavedQuery: (id: string) => unwrap<SavedQuery[]>(api['saved-queries'][':id'].$delete({ param: { id } })),
  saveSharedQuery: (name: string, sql: string) =>
    unwrap<SharedQuery[]>(api['shared-queries'].$post({ json: { name, sql } })),
  deleteSharedQuery: (id: string) => unwrap<SharedQuery[]>(api['shared-queries'][':id'].$delete({ param: { id } })),
  addSqlHistory: (entry: HistoryEntry, limit: number) =>
    unwrap<SqlHistory>(api['sql-history'].$post({ json: { entry, limit } }, { init: { keepalive: true } })),
  clearSqlHistory: () => unwrap<SqlHistory>(api['sql-history'].$delete()),
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
  saveUserGroup: (body: UserGroupBody) => unwrap<UserGroup[]>(api['user-groups'].$post({ json: body })),
  deleteUserGroup: (id: string) => unwrap<UserGroup[]>(api['user-groups'][':id'].$delete({ param: { id } })),
  saveColumnTransform: (body: ColumnTransformBody) =>
    unwrap<ColumnTransform[]>(api['column-transforms'].$post({ json: body })),
  deleteColumnTransform: (id: string) =>
    unwrap<ColumnTransform[]>(api['column-transforms'][':id'].$delete({ param: { id } })),
}

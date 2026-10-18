import type { ForeignKeyDef, IndexDef, Namespace, ReferencingKeyDef, TableSchema } from '@tsmyadmin/shared'

/** The namespace the fixtures are in, and the test of it (`homeNamespace` on MySQL, for a page of `shop`). */
const SHOP: Namespace = { database: 'shop' }
export const inShop = (ns: Namespace): boolean => ns.database === 'shop' && ns.schema === undefined

/** A table's definition as the API returns it: a primary key on `id`, nothing else, unless `over` says so. */
export const table = (name: string, over: Partial<TableSchema> = {}): TableSchema => ({
  name,
  kind: 'table',
  comment: null,
  engine: null,
  rowEstimate: null,
  partitioned: false,
  hasChildren: false,
  inherits: [],
  collation: null,
  autoIncrement: null,
  columns: [],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  ...over,
})

/** A foreign key on `columns` to `refTable`'s id, in `shop` unless `over` says otherwise. */
export const fk = (columns: string[], refTable: string, over: Partial<ForeignKeyDef> = {}): ForeignKeyDef => ({
  name: `fk_${refTable}`,
  columns,
  refNamespace: SHOP,
  refTable,
  refColumns: columns.map(() => 'id'),
  onUpdate: null,
  onDelete: null,
  ...over,
})

/** A key of `fromTable` that refers to the table it is listed on. */
export const from = (fromTable: string, over: Partial<ReferencingKeyDef> = {}): ReferencingKeyDef => ({
  name: `fk_${fromTable}`,
  fromNamespace: SHOP,
  fromTable,
  fromColumns: ['x_id'],
  columns: ['id'],
  ...over,
})

/** A plain (B-tree, whole-table) index on `columns`. */
export const index = (columns: string[], over: Partial<IndexDef> = {}): IndexDef => ({
  name: `ix_${columns.join('_')}`,
  unique: false,
  primary: false,
  columns,
  type: null,
  predicate: null,
  definition: null,
  lengths: {},
  ...over,
})

import type {
  ColumnDef,
  ForeignKeyDef,
  IndexDef,
  Namespace,
  ReferencingKeyDef,
  RelationDef,
  TableSchema,
} from '@tsmyadmin/shared'

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

/** `fk` with the table that holds it, as the list of a database's keys gives it. */
export const relation = (
  holder: string,
  columns: string[],
  refTable: string,
  over: Partial<ForeignKeyDef> = {}
): RelationDef => ({ ...fk(columns, refTable, over), table: holder })

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

/** A nullable column of `dataType` with no default, comment or collation, unless `over` says so. */
export const column = (name: string, dataType: string, over: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  dataType,
  nullable: true,
  default: null,
  defaultIsExpression: false,
  extra: '',
  comment: null,
  collation: null,
  check: null,
  generated: null,
  ...over,
})

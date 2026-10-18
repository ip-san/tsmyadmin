import type { Namespace, TableSchema } from '@tsmyadmin/shared'

/**
 * What a table is for, guessed from its keys alone:
 * - `junction`: its primary key is made of the columns of two or more foreign keys (a many-to-many link);
 * - `master`: others refer to it, it refers to none (users, products);
 * - `detail`: it refers to others, none refer to it (order lines, logs);
 * - `middle`: both (orders: they refer to a user, lines refer to them);
 * - `tree`: its only keys are to itself (a parent row of its own; a self-referring table others refer to is a master, say, with `self`);
 * - `isolated`: no key joins it to another table.
 */
export type TableRole = 'junction' | 'master' | 'detail' | 'middle' | 'tree' | 'isolated'

export interface RoleGuess {
  role: TableRole
  /** The keys it went by: how many other tables it refers to, and how many others refer to it. */
  refersTo: number
  referredBy: number
  /** A key of its own refers to itself (a parent row). */
  self: boolean
}

/**
 * The role of a table, from its foreign keys and the keys of others that refer to it. `home` says which namespace
 * the table is in: a key to a table of the same name in another database or schema is not to itself, and two
 * tables of one name in two namespaces are two tables.
 */
export function tableRole(
  schema: Pick<TableSchema, 'name' | 'primaryKey' | 'foreignKeys' | 'referencedBy'>,
  home: (ns: Namespace) => boolean
): RoleGuess {
  const own = (ns: Namespace, table: string) => home(ns) && table === schema.name
  const id = (ns: Namespace, table: string) => JSON.stringify([ns.database, ns.schema ?? null, table])
  // Its own name is not another table: a key to itself makes a tree, not a link to the rest.
  const self = schema.foreignKeys.some((k) => own(k.refNamespace, k.refTable))
  const refersTo = new Set(
    schema.foreignKeys.filter((k) => !own(k.refNamespace, k.refTable)).map((k) => id(k.refNamespace, k.refTable))
  ).size
  const referredBy = new Set(
    schema.referencedBy.filter((k) => !own(k.fromNamespace, k.fromTable)).map((k) => id(k.fromNamespace, k.fromTable))
  ).size
  const keyed = new Set(schema.foreignKeys.flatMap((k) => k.columns))
  const junction =
    schema.foreignKeys.length >= 2 && schema.primaryKey.length >= 2 && schema.primaryKey.every((c) => keyed.has(c))
  const role: TableRole = junction
    ? 'junction'
    : refersTo > 0 && referredBy > 0
      ? 'middle'
      : referredBy > 0
        ? 'master'
        : refersTo > 0
          ? 'detail'
          : self
            ? 'tree'
            : 'isolated'
  return { role, refersTo, referredBy, self }
}

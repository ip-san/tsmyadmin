import type { Dialect, Namespace, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { joinPlan } from '../base.ts'

function table(name: string, parts: Partial<TableSchema> = {}): TableSchema {
  return {
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
    primaryKey: [],
    indexes: [],
    foreignKeys: [],
    referencedBy: [],
    ...parts,
  }
}

const fk = (refNamespace: Namespace, refTable: string) => ({
  name: 'fk',
  columns: ['user_id'],
  refNamespace,
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
})

const plan = (d: Dialect, ns: Namespace, schemas: TableSchema[]) =>
  joinPlan(
    d,
    ns,
    schemas.map((s) => s.name),
    new Map(schemas.map((s) => [s.name, s]))
  )

describe('joinPlan', () => {
  it('joins along a key into the same namespace, matching every column of a composite key', () => {
    const ns = { database: 'app' }
    const composite = {
      ...fk(ns, 'users'),
      columns: ['tenant', 'user_id'],
      refColumns: ['tenant', 'id'],
    }
    expect(plan('mysql', ns, [table('posts', { foreignKeys: [composite] }), table('users')])).toEqual([
      'LEFT JOIN `app`.`users` ON `users`.`tenant` = `posts`.`tenant` AND `users`.`id` = `posts`.`user_id`',
    ])
  })

  it('ignores a key into a same-named table elsewhere', () => {
    // posts.user_id points at other.users, not at the users being queried: joining on it would be wrong.
    expect(() =>
      plan('mysql', { database: 'app' }, [
        table('posts', { foreignKeys: [fk({ database: 'other' }, 'users')] }),
        table('users'),
      ])
    ).toThrow(/No foreign key connects users/)
    expect(() =>
      plan('postgres', { database: 'app', schema: 'public' }, [
        table('posts', { foreignKeys: [fk({ database: 'app', schema: 'audit' }, 'users')] }),
        table('users'),
      ])
    ).toThrow(/No foreign key connects users/)
  })

  it('treats a missing PostgreSQL schema as public', () => {
    expect(
      plan('postgres', { database: 'app' }, [
        table('posts', { foreignKeys: [fk({ database: 'app', schema: 'public' }, 'users')] }),
        table('users'),
      ])
    ).toHaveLength(1)
  })

  it('reaches a table through one joined after the first', () => {
    const ns = { database: 'app' }
    // comments → posts → users, listed users first: comments is only reachable once posts is in.
    const joins = plan('mysql', ns, [
      table('users', { referencedBy: [] }),
      table('comments', { foreignKeys: [fk(ns, 'posts')] }),
      table('posts', { foreignKeys: [fk(ns, 'users')] }),
    ])
    expect(joins).toHaveLength(2)
  })
})

import { describe, expect, it } from 'vitest'
import { tableAliases } from './table-aliases.ts'

const of = (sql: string, dialect: 'mysql' | 'postgres' = 'mysql') => Object.fromEntries(tableAliases(sql, dialect))

describe('tableAliases', () => {
  it('reads the aliases of FROM and JOIN, with or without AS', () => {
    expect(of('SELECT * FROM posts p JOIN users AS u ON u.id = p.user_id')).toEqual({
      posts: 'posts',
      p: 'posts',
      users: 'users',
      u: 'users',
    })
  })

  it('reads a comma list after FROM, and stops at the next clause', () => {
    expect(of('SELECT a, b FROM t1 x, t2 y WHERE x.id = y.id ORDER BY a, b')).toEqual({
      t1: 't1',
      x: 't1',
      t2: 't2',
      y: 't2',
    })
  })

  it('does not take a clause word for an alias', () => {
    expect(of('SELECT * FROM users WHERE id = 1')).toEqual({ users: 'users' })
    expect(of('SELECT * FROM users LEFT JOIN posts ON true')).toEqual({ users: 'users', posts: 'posts' })
  })

  it('unquotes names and drops the database or schema', () => {
    expect(of('UPDATE `shop`.`order items` `oi` SET x = 1')).toEqual({
      'order items': 'order items',
      oi: 'order items',
    })
    expect(of('SELECT * FROM "app"."Users" "U"', 'postgres')).toEqual({ Users: 'Users', U: 'Users' })
    expect(of('SELECT * FROM `a``b` t')).toEqual({ 'a`b': 'a`b', t: 'a`b' })
  })

  it('reads INSERT … SELECT and subqueries', () => {
    expect(of('INSERT INTO log SELECT * FROM users u WHERE u.id IN (SELECT user_id FROM posts)')).toEqual({
      log: 'log',
      users: 'users',
      u: 'users',
      posts: 'posts',
    })
  })

  it('ignores what is in strings and comments, and leaves derived tables out', () => {
    expect(of("SELECT 'from fake f' FROM users u -- join other o\n")).toEqual({ users: 'users', u: 'users' })
    expect(of('SELECT * FROM (SELECT id FROM users) d')).toEqual({ users: 'users' })
  })
})

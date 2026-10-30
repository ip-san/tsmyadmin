import { readFileSync } from 'node:fs'
import type { PlanNode } from '@tsmyadmin/shared'

/**
 * Plans captured from real servers (`EXPLAIN FORMAT=JSON` / `EXPLAIN (FORMAT JSON)` over the docker fixtures, for
 * MySQL 8.4 (8.0 gives the same), MySQL 9.7, MariaDB 10.11 and 11.4, PostgreSQL 17), one file per server and query.
 */
export const plan = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'))

/** The statements the plans are of. */
export const PLAN_SQL = {
  q1: "SELECT p.title, u.name FROM posts p JOIN users u ON u.id = p.user_id WHERE u.email = 'alice@example.com'",
  q2: "SELECT * FROM users WHERE name LIKE 'A%' ORDER BY age",
  q3: 'SELECT u.name, (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS n FROM users u WHERE u.id IN (SELECT user_id FROM posts) GROUP BY u.id, u.name ORDER BY n DESC',
  q4: "UPDATE posts SET title = 'x' WHERE id = 1",
  /** Measured (`*-analyze`): `EXPLAIN ANALYZE FORMAT=JSON` in format 2, MariaDB's `ANALYZE FORMAT=JSON`, `EXPLAIN (ANALYZE)`. */
  analyze: 'SELECT p.title, u.name FROM posts p JOIN users u ON u.id = p.user_id',
} as const

/** The nodes that read a table, in the order the tree lists them: what a diagram lights up. */
export function reads(n: PlanNode): string[] {
  const self = n.table
    ? [
        [n.table, n.alias && `as ${n.alias}`, n.index && `by ${n.index}`, n.access, n.covering && 'covering']
          .filter(Boolean)
          .join(' '),
      ]
    : []
  return [...self, ...n.children.flatMap(reads)]
}

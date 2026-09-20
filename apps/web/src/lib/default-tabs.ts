import { resolveSettings } from './settings.ts'

const SERVER_HOME = {
  databases: '/',
  sql: '/sql',
  status: '/status',
  variables: '/variables',
  processes: '/processes',
  users: '/users',
} as const

const DB_HOME = {
  structure: '/db/$db',
  sql: '/db/$db/sql',
  search: '/db/$db/search',
  query: '/db/$db/query',
} as const

const TABLE_HOME = {
  browse: '/db/$db/table/$table',
  structure: '/db/$db/table/$table/structure',
  search: '/db/$db/table/$table/search',
  insert: '/db/$db/table/$table/insert',
} as const

/**
 * The tab a link into the server, a database or a table opens on (phpMyAdmin's "default tab" settings). Only links
 * that *enter* a level use these; the tab strips themselves always go where they say.
 */
export const serverHomePath = () => SERVER_HOME[resolveSettings().defaultServerTab]
export const dbHomeTo = () => DB_HOME[resolveSettings().defaultDbTab]
export const tableHomeTo = () => TABLE_HOME[resolveSettings().defaultTableTab]

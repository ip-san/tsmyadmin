import type { Dialect } from '@tsmyadmin/shared'
import type { createApp } from '../../app.ts'

/**
 * What the groups of the integration suite share with the file that logs in: the dialect, a request that carries the
 * session's cookie, the app, and the cookie itself (read when used: it is set by the first test).
 */
export interface IntegrationContext {
  readonly dialect: Dialect
  req(path: string, init?: RequestInit): ReturnType<ReturnType<typeof createApp>['request']>
  readonly app: ReturnType<typeof createApp>
  readonly cookie: string
}

import { createHmac } from 'node:crypto'
import type { ConnectRequest } from '@tsmyadmin/shared'

/**
 * Groups sessions that hold pools against the same account. Bounding this keeps one account holder from
 * exhausting the database's max_connections by logging in repeatedly (each session pings and pools connections).
 */
export function identityKey(config: ConnectRequest): string {
  return `${config.dialect}|${config.host.toLowerCase()}|${config.port}|${config.user}`
}

/** The account an at-rest row belongs to, as an HMAC: the plain user / host never reaches the file. */
export function identityHash(key: Buffer, config: ConnectRequest): string {
  return createHmac('sha256', key).update(identityKey(config)).digest('hex')
}

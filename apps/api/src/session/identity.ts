import { createHmac } from 'node:crypto'
import type { ConnectRequest } from '@tsmyadmin/shared'

/**
 * `|` separates the fields below, so a field that contains one is escaped — otherwise two different accounts
 * render to the same string (`identity.test.ts` holds the pair). `\\` is escaped too, which makes this a whole
 * reversible escape instead of one that only works while the port is numeric; that pair alone is not enough to
 * demonstrate a collision, and it is not meant to be. A field with neither character comes out unchanged, which
 * is why this could be tightened without re-keying a single stored identity.
 */
const field = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|')

/**
 * Groups sessions that hold pools against the same account. Bounding this keeps one account holder from
 * exhausting the database's max_connections by logging in repeatedly (each session pings and pools connections).
 *
 * It also decides which saved queries belong to whom (as an HMAC of this), so two accounts must never collide
 * here: `identity.test.ts` holds that as its own case, alongside the values this produced before the escaping.
 */
export function identityKey(config: ConnectRequest): string {
  return [config.dialect, field(config.host.toLowerCase()), config.port, field(config.user)].join('|')
}

/**
 * The server a row shared by all its accounts belongs to (tracking, user groups): dialect, host and port. Starts
 * with a field no identityKey can have (`server` is not a dialect), so a server and an account never share a key.
 */
function serverKey(config: ConnectRequest): string {
  return ['server', config.dialect, field(config.host.toLowerCase()), config.port].join('|')
}

/** The server a shared row belongs to, as an HMAC, like an account's. */
export function serverHash(key: Buffer, config: ConnectRequest): string {
  return createHmac('sha256', key).update(serverKey(config)).digest('hex')
}

/** The account an at-rest row belongs to, as an HMAC: the plain user / host never reaches the file. */
export function identityHash(key: Buffer, config: ConnectRequest): string {
  return createHmac('sha256', key).update(identityKey(config)).digest('hex')
}

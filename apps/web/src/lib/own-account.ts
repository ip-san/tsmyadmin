import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { UserRef } from '@tsmyadmin/shared'
import { serverInfoQuery } from './queries.ts'

/**
 * The account this session is logged in as. MySQL accounts are name@host: `root@localhost` is not the `root@%` we
 * are logged in as. CURRENT_USER() (the matched account) comes from the server info; until it is known the host is
 * left open and the name alone decides.
 */
export function useOwnAccount(): { ref: UserRef; is: (user: UserRef) => boolean } {
  const { session } = useRouteContext({ from: '/_app' })
  const info = useQuery(serverInfoQuery)
  const current = info.data?.currentUser ?? ''
  const at = current.lastIndexOf('@')
  const host = session.dialect === 'mysql' && at > 0 ? current.slice(at + 1).replace(/^'|'$/g, '') : null
  return {
    ref: host === null ? { name: session.user } : { name: session.user, host },
    is: (user) => user.name === session.user && (host === null || !user.host || user.host === host),
  }
}

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { locale } from '@/config/locale.ts'
import { serverContactAt } from '@/lib/api.ts'
import { sessionQuery } from '@/lib/queries.ts'
import { Button } from '../ui/Button.tsx'

const TICK_MS = 15_000
const WARN_BEFORE_S = 120

/** Seconds a session lasts, and how long before its end the notice appears (never in the first half of a short TTL). */
const warnAfterSeconds = (ttl: number) => (ttl > WARN_BEFORE_S * 2 ? ttl - WARN_BEFORE_S : ttl / 2)

/**
 * The session slides: every answer from the server starts it again, so this only shows when nothing has been
 * asked for almost the whole TTL. "Keep the session" asks once, which is all it takes.
 */
export function SessionExpiryNotice({ ttlSeconds }: { ttlSeconds: number | undefined }) {
  const queryClient = useQueryClient()
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!ttlSeconds) return
    const check = () => {
      const idle = (Date.now() - serverContactAt()) / 1000
      setLeft(idle >= warnAfterSeconds(ttlSeconds) ? Math.max(0, Math.ceil(ttlSeconds - idle)) : null)
    }
    check()
    const timer = setInterval(check, TICK_MS)
    return () => clearInterval(timer)
  }, [ttlSeconds])
  const extend = async () => {
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey })
    setLeft(null)
  }
  return (
    <output aria-live="polite" className={left === null ? 'sr-only' : 'block'}>
      {left === null ? null : (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <span>{locale.session.expiring(Math.max(1, Math.ceil(left / 60)))}</span>
          <Button size="sm" onClick={extend}>
            {locale.session.extend}
          </Button>
        </div>
      )}
    </output>
  )
}

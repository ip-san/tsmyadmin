import { Link, useRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { errorMessage } from '@/lib/format.ts'

function Frame({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <section className="mx-auto flex max-w-lg flex-col gap-3 p-8" aria-labelledby="error-title">
      <h1 id="error-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        {title}
      </h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{body}</p>
      {children}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          {locale.common.reload}
        </Button>
        <Link to="/" className="inline-flex items-center text-sm text-blue-700 hover:underline dark:text-blue-300">
          {locale.common.backHome}
        </Link>
      </div>
    </section>
  )
}

/** Router-level error boundary: a render-time throw shows this instead of a blank page. */
export function ErrorPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const router = useRouter()
  return (
    <Frame title={locale.errorPage.title} body={locale.errorPage.body}>
      <pre
        role="alert"
        className="overflow-auto rounded border border-red-300 bg-red-50 p-2 font-mono text-xs text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
      >
        {errorMessage(error)}
      </pre>
      {reset ? (
        <div>
          <Button
            onClick={() => {
              reset()
              void router.invalidate()
            }}
          >
            {locale.common.retry}
          </Button>
        </div>
      ) : null}
    </Frame>
  )
}

export function NotFoundPage() {
  return <Frame title={locale.errorPage.notFoundTitle} body={locale.errorPage.notFoundBody} />
}

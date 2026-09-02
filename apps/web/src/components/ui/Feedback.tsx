import type { ReactNode } from 'react'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { errorMessage } from '@/lib/format.ts'

export function Spinner({ label = locale.common.loading }: { label?: string }) {
  return (
    <output className="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400" aria-live="polite">
      <span className="size-4 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600 dark:border-zinc-600 dark:border-t-blue-400" />
      {label}
    </output>
  )
}

/** Error banner. Pass `onRetry` for query failures so the user can refetch without reloading the page. */
export function ErrorBox({ error, className, onRetry }: { error: unknown; className?: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200',
        className
      )}
    >
      <span className="min-w-0 flex-1 break-words">
        <strong className="mr-1">{locale.common.error}:</strong>
        {errorMessage(error)}
      </span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-900 dark:text-red-100 dark:hover:bg-red-800"
        >
          {locale.common.retry}
        </button>
      ) : null}
    </div>
  )
}

export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
        className
      )}
    >
      {children}
    </div>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'info' | 'warn' }) {
  const tones = {
    neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  }
  return <span className={cn('inline-block rounded px-1.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>
}

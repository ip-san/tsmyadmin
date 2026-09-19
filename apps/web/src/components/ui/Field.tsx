import {
  Children,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn.ts'

const control =
  'w-full rounded-control border border-line-strong bg-surface px-2.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:bg-surface-sub disabled:text-ink-faint'

export function Input({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(control, className)} {...rest} />
}

export function Textarea({
  className,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(control, className)} {...rest} />
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  // Tailwind emits `w-auto` before `w-full`, so a caller's width class must replace the control's, not join it.
  const base = className && /(?:^|\s)w-/.test(className) ? control.replace('w-full ', '') : control
  return <select className={cn(base, 'select-chevron', className)} {...rest} />
}

function Label({ children, htmlFor, className }: { children: ReactNode; htmlFor: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('mb-1 block text-xs font-medium text-ink-sub', className)}>
      {children}
    </label>
  )
}

export function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string
  label: string
  children: ReactNode
  hint?: string
}) {
  // The hint is associated with the (single) control automatically so screen readers read it with the field.
  const hintId = hint ? `${id}-hint` : undefined
  const control =
    hintId && Children.count(children) === 1 && isValidElement<{ 'aria-describedby'?: string }>(children)
      ? cloneElement(children, { 'aria-describedby': children.props['aria-describedby'] ?? hintId })
      : children
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-ink-sub">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

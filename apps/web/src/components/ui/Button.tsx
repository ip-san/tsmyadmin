import type { ButtonHTMLAttributes, Ref } from 'react'
import { cn } from '@/lib/cn.ts'

type Variant = 'primary' | 'secondary' | 'danger' | 'criticalSolid' | 'ghost' | 'icon'
type Size = 'sm' | 'md' | 'icon'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover disabled:opacity-50',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-sub',
  /**
   * Destructive actions are a colour, not a filled block (Polaris's `tone="critical"`). A structure page lists
   * one per row, and a column of solid red made the most dangerous control the loudest thing on the screen.
   * Filled red is kept for the one button inside a confirmation dialog, where it is the only action.
   */
  danger: 'bg-surface text-critical border border-critical/40 hover:bg-critical-sub',
  criticalSolid: 'bg-critical text-white hover:opacity-90 disabled:opacity-50',
  ghost: 'bg-transparent text-ink-sub hover:bg-surface-sub hover:text-ink',
  /** Icon-only control inside a table row: quieter colour, lighter when disabled. */
  icon: 'bg-transparent text-ink-faint enabled:hover:bg-surface-sub enabled:hover:text-ink',
}
const SIZES: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
  icon: 'min-h-6 min-w-6 justify-center p-0',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      // WebKit does not focus a clicked button (and undoes a focus set on mousedown), so a dialog opener would
      // have nothing to hand focus back to: every button takes focus on click, as Chromium does natively.
      onClick={(e) => {
        // Pointer clicks only (detail > 0): Enter in a field submits through a synthetic click and the field keeps focus.
        if (e.detail > 0 && document.activeElement !== e.currentTarget) e.currentTarget.focus()
        onClick?.(e)
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-control font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed',
        variant === 'icon' ? 'disabled:opacity-40' : 'disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...rest}
    />
  )
}

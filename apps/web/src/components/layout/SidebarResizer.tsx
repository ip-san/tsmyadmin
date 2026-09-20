import { type KeyboardEvent, type PointerEvent, useRef } from 'react'
import { locale } from '@/config/locale.ts'

const NAV_MIN = 200
const NAV_MAX = 480
const STEP = 16

const clampWidth = (w: number) => Math.min(NAV_MAX, Math.max(NAV_MIN, Math.round(w)))

/**
 * The edge between the sidebar and the page: drag it, or focus it and use the arrow keys, to change the sidebar's
 * width (200 to 480 px). `onChange` gets each width while it moves, `onCommit` the one it ends on.
 */
export function SidebarResizer({
  width,
  onChange,
  onCommit,
}: {
  width: number
  onChange: (width: number) => void
  onCommit: (width: number) => void
}) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null)
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    d.last = clampWidth(d.startWidth + e.clientX - d.startX)
    onChange(d.last)
  }
  const end = () => {
    const d = drag.current
    drag.current = null
    if (d) onCommit(d.last)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP * 4 : STEP
    const next =
      e.key === 'ArrowLeft'
        ? width - step
        : e.key === 'ArrowRight'
          ? width + step
          : e.key === 'Home'
            ? NAV_MIN
            : e.key === 'End'
              ? NAV_MAX
              : null
    if (next === null) return
    e.preventDefault()
    onCommit(clampWidth(next))
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that can be moved is a "slider" of the window splitter pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={locale.nav.resizeSidebar}
      aria-valuemin={NAV_MIN}
      aria-valuemax={NAV_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className="hidden w-1.5 shrink-0 cursor-col-resize touch-none bg-transparent hover:bg-brand/40 focus-visible:bg-brand/60 focus-visible:outline-none md:block print:hidden"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { startX: e.clientX, startWidth: width, last: width }
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={key}
    />
  )
}

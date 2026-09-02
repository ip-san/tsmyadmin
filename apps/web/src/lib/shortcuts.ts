import { useEffect, useLayoutEffect, useRef } from 'react'

export interface Shortcut {
  /** e.g. 'mod+k', 'shift+/', 'arrowleft' — `mod` is ⌘ on macOS and Ctrl elsewhere. */
  keys: string
  /** Fire even while an input/textarea/contenteditable has focus (default false). */
  global?: boolean
  handler: (event: KeyboardEvent) => void
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Non-global shortcuts must not fire while a modal is open (a keydown inside <dialog> bubbles to document) or
 * when the key has its own meaning on the focused element (arrows on a link/button/scroll container).
 */
function isCaptured(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('dialog[open]')) return true
  const tag = target.tagName
  return tag === 'A' || tag === 'BUTTON' || target.closest('[data-scroll-root]') !== null
}

/** Compares a KeyboardEvent against a 'mod+shift+k' style description. */
export function matches(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.toLowerCase().split('+')
  const key = parts[parts.length - 1] ?? ''
  const mod = parts.includes('mod')
  const shift = parts.includes('shift')
  const alt = parts.includes('alt')
  const wantMeta = mod && IS_MAC
  const wantCtrl = mod && !IS_MAC
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl || event.shiftKey !== shift || event.altKey !== alt)
    return false
  return event.key.toLowerCase() === key
}

/**
 * Registers document-level shortcuts for the lifetime of the component. The listener is attached once; the
 * latest `shortcuts` array is read through a ref, so callers may pass inline literals without re-registering.
 */
export function useShortcuts(shortcuts: Shortcut[]): void {
  const latest = useRef(shortcuts)
  useLayoutEffect(() => {
    latest.current = shortcuts
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const editing = isEditable(event.target) || isCaptured(event.target)
      for (const s of latest.current) {
        if (editing && !s.global) continue
        if (matches(event, s.keys)) {
          event.preventDefault()
          s.handler(event)
          return
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

/** Human-readable label for the help dialog. */
export function shortcutLabel(keys: string): string {
  return keys
    .split('+')
    .map((k) =>
      k === 'mod'
        ? IS_MAC
          ? '⌘'
          : 'Ctrl'
        : k === 'shift'
          ? 'Shift'
          : k === 'alt'
            ? 'Alt'
            : k === 'arrowleft'
              ? '←'
              : k === 'arrowright'
                ? '→'
                : k === 'enter'
                  ? 'Enter'
                  : k.toUpperCase()
    )
    .join(' + ')
}

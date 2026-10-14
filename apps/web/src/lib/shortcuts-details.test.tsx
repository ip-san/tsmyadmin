import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IS_MAC, matches, type Shortcut, shortcutLabel, useShortcuts } from './shortcuts.ts'

const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
// jsdom's navigator.platform is '', so these tests run as on a non-Mac: mod is Ctrl. The Mac side is loaded under a
// stubbed platform below.
const MOD = { ctrlKey: true }
const OTHER_MOD = { metaKey: true }

describe('matches', () => {
  it('rejects the other platform’s modifier for mod', () => {
    expect(IS_MAC).toBe(false)
    expect(matches(ev({ key: 'k', ...OTHER_MOD }), 'mod+k')).toBe(false)
    expect(matches(ev({ key: 'k', ...MOD }), 'mod+k')).toBe(true)
  })
  it('requires alt exactly when the description has it', () => {
    expect(matches(ev({ key: 'x', altKey: true }), 'alt+x')).toBe(true)
    expect(matches(ev({ key: 'x' }), 'alt+x')).toBe(false)
    expect(matches(ev({ key: 'x', altKey: true }), 'x')).toBe(false)
  })
  it('requires shift exactly when the description has it', () => {
    expect(matches(ev({ key: 'x', shiftKey: true }), 'x')).toBe(false)
    expect(matches(ev({ key: 'x' }), 'shift+x')).toBe(false)
  })
  it('compares the key itself, ignoring case', () => {
    expect(matches(ev({ key: 'j' }), 'k')).toBe(false)
    expect(matches(ev({ key: 'K' }), 'k')).toBe(true)
    expect(matches(ev({ key: 'k' }), 'K')).toBe(true)
    expect(matches(ev({ key: '/', shiftKey: true }), 'SHIFT+/')).toBe(true)
  })
})

describe('matches on a Mac', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('maps mod to the command key and not to control', async () => {
    vi.resetModules()
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    const mac = await import('./shortcuts.ts')
    expect(mac.IS_MAC).toBe(true)
    expect(mac.matches(ev({ key: 'k', metaKey: true }), 'mod+k')).toBe(true)
    expect(mac.matches(ev({ key: 'k', ctrlKey: true }), 'mod+k')).toBe(false)
    expect(mac.matches(ev({ key: 'k' }), 'mod+k')).toBe(false)
    // Without mod, neither is wanted.
    expect(mac.matches(ev({ key: 'k', metaKey: true }), 'k')).toBe(false)
    expect(mac.shortcutLabel('mod+k')).toBe('⌘ + K')
  })
})

describe('shortcutLabel', () => {
  it('names each special key', () => {
    expect(shortcutLabel('ctrl+k')).toBe('Ctrl + K')
    expect(shortcutLabel('space')).toBe('Space')
    expect(shortcutLabel('shift+/')).toBe('Shift + /')
    expect(shortcutLabel('alt+x')).toBe('Alt + X')
    expect(shortcutLabel('arrowleft')).toBe('←')
    expect(shortcutLabel('arrowright')).toBe('→')
    expect(shortcutLabel('enter')).toBe('Enter')
  })
  it('upper-cases any other key and keeps the order', () => {
    expect(shortcutLabel('mod+shift+g')).toBe('Ctrl + Shift + G')
    expect(shortcutLabel('escape')).toBe('ESCAPE')
    expect(shortcutLabel('')).toBe('')
  })
})

describe('useShortcuts', () => {
  const fire = (target: EventTarget, init: KeyboardEventInit) => {
    const event = ev({ bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const mount = (shortcuts: Shortcut[]) => renderHook(({ s }) => useShortcuts(s), { initialProps: { s: shortcuts } })
  /** Elements put in the document for one test; taken out again after it, whether it passed or not. */
  const added: HTMLElement[] = []
  const append = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement = document.body) => {
    const el = parent.appendChild(document.createElement(tag))
    added.push(el)
    return el
  }
  afterEach(() => {
    for (const el of added.splice(0)) el.remove()
    vi.restoreAllMocks()
  })

  it('runs the handler, stops the browser’s own action, and stops at the first match', () => {
    const first = vi.fn()
    const second = vi.fn()
    mount([
      { keys: 'k', handler: first },
      { keys: 'k', handler: second },
    ])
    const event = fire(document.body, { key: 'k' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith(event)
    expect(second).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a key nobody asked for alone', () => {
    const handler = vi.fn()
    mount([{ keys: 'k', handler }])
    const event = fire(document.body, { key: 'j' })
    expect(handler).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('skips a non-matching shortcut and runs a later one', () => {
    const a = vi.fn()
    const b = vi.fn()
    mount([
      { keys: 'a', handler: a },
      { keys: 'b', handler: b },
    ])
    fire(document.body, { key: 'b' })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('does not fire while typing, unless the shortcut is global', () => {
    const plain = vi.fn()
    const global = vi.fn()
    mount([
      { keys: 'k', handler: plain },
      { keys: 'j', global: true, handler: global },
    ])
    for (const tag of ['input', 'textarea', 'select'] as const) {
      const el = append(tag)
      fire(el, { key: 'k' })
      fire(el, { key: 'j' })
    }
    expect(plain).not.toHaveBeenCalled()
    expect(global).toHaveBeenCalledTimes(3)
  })

  it('does not fire inside a contenteditable element', () => {
    const handler = vi.fn()
    mount([{ keys: 'k', handler }])
    const el = append('div')
    // jsdom does not implement isContentEditable, so it is stated directly.
    Object.defineProperty(el, 'isContentEditable', { value: true })
    fire(el, { key: 'k' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not fire inside an open dialog, on a link or button, or in a scroll root', () => {
    const handler = vi.fn()
    const global = vi.fn()
    mount([
      { keys: 'k', handler },
      { keys: 'j', global: true, handler: global },
    ])
    const dialog = append('dialog')
    dialog.setAttribute('open', '')
    const inDialog = append('div', dialog)
    const link = append('a')
    const button = append('button')
    const root = append('div')
    root.setAttribute('data-scroll-root', '')
    const inRoot = append('span', root)
    for (const el of [inDialog, link, button, inRoot]) {
      fire(el, { key: 'k' })
      fire(el, { key: 'j' })
    }
    expect(handler).not.toHaveBeenCalled()
    expect(global).toHaveBeenCalledTimes(4)
  })

  it('fires in a closed dialog and in an ordinary element', () => {
    const handler = vi.fn()
    mount([{ keys: 'k', handler }])
    const inside = append('div', append('dialog'))
    const div = append('div')
    fire(inside, { key: 'k' })
    fire(div, { key: 'k' })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('uses the latest shortcuts without registering again', () => {
    const old = vi.fn()
    const fresh = vi.fn()
    const add = vi.spyOn(document, 'addEventListener')
    const hook = mount([{ keys: 'k', handler: old }])
    hook.rerender({ s: [{ keys: 'k', handler: fresh }] })
    fire(document.body, { key: 'k' })
    expect(old).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
  })

  it('stops listening when unmounted', () => {
    const handler = vi.fn()
    const hook = mount([{ keys: 'k', handler }])
    hook.unmount()
    fire(document.body, { key: 'k' })
    expect(handler).not.toHaveBeenCalled()
  })
})

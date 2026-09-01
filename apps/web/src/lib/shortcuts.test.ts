import { describe, expect, it } from 'vitest'
import { IS_MAC, matches, shortcutLabel } from './shortcuts.ts'

const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

describe('matches', () => {
  it('maps mod to the platform modifier and requires exact modifier state', () => {
    const modKey = IS_MAC ? { metaKey: true } : { ctrlKey: true }
    expect(matches(ev({ key: 'k', ...modKey }), 'mod+k')).toBe(true)
    expect(matches(ev({ key: 'k' }), 'mod+k')).toBe(false)
    expect(matches(ev({ key: 'k', ...modKey, shiftKey: true }), 'mod+k')).toBe(false)
    expect(matches(ev({ key: '?', shiftKey: true }), 'shift+?')).toBe(true)
    expect(matches(ev({ key: 'ArrowLeft' }), 'arrowleft')).toBe(true)
  })
})

describe('shortcutLabel', () => {
  it('renders readable labels', () => {
    expect(shortcutLabel('mod+enter')).toBe(`${IS_MAC ? '⌘' : 'Ctrl'} + Enter`)
    expect(shortcutLabel('arrowright')).toBe('→')
  })
})

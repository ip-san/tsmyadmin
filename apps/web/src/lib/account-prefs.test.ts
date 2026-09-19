import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const put = vi.fn(async (_body: unknown, _init?: unknown) => new Response('{}'))
const get = vi.fn(async () => new Response('{}'))

vi.mock('@/lib/api.ts', () => ({
  api: { preferences: { $get: () => get(), $put: (body: unknown, init: unknown) => put(body, init) } },
  unwrap: async (res: Promise<Response>) => (await res).json(),
}))
vi.mock('@/lib/theme.ts', () => ({ setTheme: vi.fn() }))

const prefs = await import('./account-prefs.ts')

describe('account preferences', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    put.mockClear()
    get.mockClear()
    prefs.resetAccountPreferences()
  })
  afterEach(() => vi.useRealTimers())

  it('sends a change after a pause, merged with what was set before', async () => {
    await prefs.loadAccountPreferences('a', true)
    prefs.sharePreference({ theme: 'dark' })
    prefs.sharePreference({ consoleDocked: true })
    expect(put).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0]?.[0]).toEqual({ json: { theme: 'dark', consoleDocked: true } })
  })

  it('never sends one account’s pending change as the next account', async () => {
    await prefs.loadAccountPreferences('a', true)
    prefs.sharePreference({ sqlSafeMode: false })
    // Logged out before the pause ended…
    prefs.resetAccountPreferences()
    await vi.advanceTimersByTimeAsync(600)
    expect(put).not.toHaveBeenCalled()

    // …or the session expired and someone else signed in without a logout in between.
    await prefs.loadAccountPreferences('a', true)
    prefs.sharePreference({ sqlSafeMode: false })
    await prefs.loadAccountPreferences('b', true)
    await vi.advanceTimersByTimeAsync(600)
    expect(put).not.toHaveBeenCalled()
  })

  it('keeps everything in the browser where the store cannot keep it', async () => {
    await prefs.loadAccountPreferences('a', false)
    prefs.sharePreference({ theme: 'dark' })
    await vi.advanceTimersByTimeAsync(600)
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })
})

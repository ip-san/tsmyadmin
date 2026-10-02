import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const put = vi.fn(async (_body: unknown, _init?: unknown) => new Response('{}'))
const putWorkspace = vi.fn(async (_body: unknown, _init?: unknown) => new Response('{}'))
const get = vi.fn(async () => new Response('{}'))

vi.mock('@/lib/api.ts', () => ({
  api: {
    preferences: { $get: () => get(), $put: (body: unknown, init: unknown) => put(body, init) },
    workspace: {
      $get: async () => new Response('{"entries":{}}'),
      $put: (body: unknown, init: unknown) => putWorkspace(body, init),
    },
  },
  unwrap: async (res: Promise<Response>) => (await res).json(),
}))
vi.mock('@/lib/theme.ts', () => ({ setTheme: vi.fn() }))

const prefs = await import('./account-prefs.ts')

describe('account preferences', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    put.mockClear()
    putWorkspace.mockClear()
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

  it('does not hand a send that failed after the logout to the next account', async () => {
    await prefs.loadAccountPreferences('a', true)
    let fail: (reason: unknown) => void = () => undefined
    put.mockImplementationOnce(
      () =>
        new Promise<Response>((_, reject) => {
          fail = reject
        })
    )
    prefs.sharePreference({ sqlSafeMode: false })
    await vi.advanceTimersByTimeAsync(600)
    expect(put).toHaveBeenCalledTimes(1)
    // Logged out while that request was still on its way, and another account signed in; only then does it fail. A
    // failed send keeps its change for the next one, but this one belonged to the account that has gone.
    prefs.resetAccountPreferences()
    await prefs.loadAccountPreferences('b', true)
    fail(new Error('network'))
    await vi.advanceTimersByTimeAsync(0)
    prefs.sharePreference({ theme: 'dark' })
    await vi.advanceTimersByTimeAsync(600)
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[1]?.[0]).toEqual({ json: { theme: 'dark' } })
  })

  it('does not hand a failed workspace send of the account that has gone to the next one either', async () => {
    await prefs.loadAccountPreferences('a', true)
    let fail: (reason: unknown) => void = () => undefined
    putWorkspace.mockImplementationOnce(
      () =>
        new Promise<Response>((_, reject) => {
          fail = reject
        })
    )
    prefs.shareWorkspaceEntry('tables.favorites.a', ['users'])
    await vi.advanceTimersByTimeAsync(600)
    expect(putWorkspace).toHaveBeenCalledTimes(1)
    prefs.resetAccountPreferences()
    await prefs.loadAccountPreferences('b', true)
    fail(new Error('network'))
    await vi.advanceTimersByTimeAsync(0)
    prefs.shareWorkspaceEntry('tables.favorites.b', ['orders'])
    await vi.advanceTimersByTimeAsync(600)
    expect(putWorkspace).toHaveBeenCalledTimes(2)
    expect(putWorkspace.mock.calls[1]?.[0]).toEqual({ json: { set: { 'tables.favorites.b': ['orders'] }, remove: [] } })
  })

  it('still keeps a failed send for the next one within the same login', async () => {
    await prefs.loadAccountPreferences('a', true)
    put.mockImplementationOnce(async () => Promise.reject(new Error('network')))
    prefs.sharePreference({ sqlSafeMode: false })
    await vi.advanceTimersByTimeAsync(600)
    prefs.sharePreference({ theme: 'dark' })
    await vi.advanceTimersByTimeAsync(600)
    expect(put.mock.calls[1]?.[0]).toEqual({ json: { sqlSafeMode: false, theme: 'dark' } })
  })

  it('keeps everything in the browser where the store cannot keep it', async () => {
    await prefs.loadAccountPreferences('a', false)
    prefs.sharePreference({ theme: 'dark' })
    await vi.advanceTimersByTimeAsync(600)
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })
})

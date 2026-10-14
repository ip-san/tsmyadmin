import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as prefs from './account-prefs.ts'

const json = (body: unknown) => new Response(JSON.stringify(body))
// Hoisted with the mocks: the module under test imports the API at load time, before the file's own body runs.
const { put, putWorkspace, get, getWorkspace, setTheme } = vi.hoisted(() => {
  const reply = (body: unknown) => new Response(JSON.stringify(body))
  return {
    put: vi.fn(async (_body: unknown, _init?: unknown) => reply({})),
    putWorkspace: vi.fn(async (_body: unknown, _init?: unknown) => reply({})),
    get: vi.fn(async () => reply({})),
    getWorkspace: vi.fn(async () => reply({ entries: {} })),
    setTheme: vi.fn(),
  }
})

vi.mock('@/lib/api.ts', () => ({
  api: {
    preferences: { $get: () => get(), $put: (body: unknown, init: unknown) => put(body, init) },
    workspace: { $get: () => getWorkspace(), $put: (body: unknown, init: unknown) => putWorkspace(body, init) },
  },
  unwrap: async (res: Promise<Response>) => (await res).json(),
}))
vi.mock('@/lib/theme.ts', () => ({ setTheme: (t: unknown) => setTheme(t) }))

const KEEPALIVE = { init: { keepalive: true } }

describe('account preferences', () => {
  let data: Map<string, string>
  let failWrites = false

  beforeEach(() => {
    vi.useFakeTimers()
    data = new Map()
    failWrites = false
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failWrites) throw new Error('quota')
        data.set(k, v)
      },
      removeItem: (k: string) => void data.delete(k),
    })
    for (const m of [put, putWorkspace, get, getWorkspace, setTheme]) m.mockClear()
    get.mockImplementation(async () => json({}))
    getWorkspace.mockImplementation(async () => json({ entries: {} }))
    prefs.resetAccountPreferences()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const stored = (key: string) => data.get(`tsmyadmin.pref.${key}`)

  describe('loading', () => {
    it('reads nothing and reports no reload where the browser keeps the settings', async () => {
      expect(await prefs.loadAccountPreferences('a', false)).toEqual({ reload: false })
      expect(get).not.toHaveBeenCalled()
      expect(getWorkspace).not.toHaveBeenCalled()
    })

    it('reads the account once per login, and again for another account', async () => {
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
      expect(get).toHaveBeenCalledTimes(1)
      await prefs.loadAccountPreferences('b', true)
      expect(get).toHaveBeenCalledTimes(2)
    })

    it('reads again after the logout', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.resetAccountPreferences()
      await prefs.loadAccountPreferences('a', true)
      expect(get).toHaveBeenCalledTimes(2)
    })

    it('lays the account’s values over this browser’s, only those the account has', async () => {
      data.set('tsmyadmin.pref.browse.limit', '50')
      get.mockImplementation(async () => json({ browseLimit: 200, sqlSafeMode: false, navHidden: ['x'] }))
      await prefs.loadAccountPreferences('a', true)
      expect(stored('browse.limit')).toBe('200')
      expect(stored('sql.safeMode')).toBe('false')
      expect(stored('nav.hidden')).toBe('["x"]')
      // A value the account does not have leaves this browser’s alone, and nothing is written for it.
      expect(stored('nav.width')).toBeUndefined()
      expect(stored('confirm.drop')).toBeUndefined()
      expect([...data.keys()].sort()).toEqual([
        'tsmyadmin.pref.browse.limit',
        'tsmyadmin.pref.nav.hidden',
        'tsmyadmin.pref.sql.safeMode',
      ])
    })

    it('applies the account’s theme only when it has one', async () => {
      await prefs.loadAccountPreferences('a', true)
      expect(setTheme).not.toHaveBeenCalled()
      get.mockImplementation(async () => json({ theme: 'dark' }))
      await prefs.loadAccountPreferences('b', true)
      expect(setTheme).toHaveBeenCalledTimes(1)
      expect(setTheme).toHaveBeenCalledWith('dark')
      // The theme is applied through the theme module, not stored under a preference key.
      expect(data.size).toBe(0)
    })

    it('lays the account’s workspace entries over this browser’s', async () => {
      getWorkspace.mockImplementation(async () =>
        json({ entries: { 'tables.favorites.s': [{ db: 'd', table: 't' }], 'sidebar.collapsed': ['x'] } })
      )
      await prefs.loadAccountPreferences('a', true)
      expect(stored('tables.favorites.s')).toBe('[{"db":"d","table":"t"}]')
      expect(stored('sidebar.collapsed')).toBe('["x"]')
    })

    it('still applies the preferences when the workspace cannot be read', async () => {
      getWorkspace.mockImplementation(async () => {
        throw new Error('down')
      })
      get.mockImplementation(async () => json({ browseLimit: 10 }))
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
      expect(stored('browse.limit')).toBe('10')
    })

    it('leaves everything as it was when the preferences cannot be read', async () => {
      get.mockImplementation(async () => {
        throw new Error('down')
      })
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
      expect(getWorkspace).not.toHaveBeenCalled()
      expect(setTheme).not.toHaveBeenCalled()
      expect(data.size).toBe(0)
    })

    it('leaves everything as it was when the preferences are not in the expected shape', async () => {
      get.mockImplementation(async () => json({ browseLimit: 'many' }))
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
      expect(data.size).toBe(0)
    })
  })

  describe('the language', () => {
    // The tests run in Japanese (src/test/setup.ts).
    it('asks for a reload when the account’s language is another one this build has', async () => {
      get.mockImplementation(async () => json({ locale: 'en' }))
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: true })
      expect(stored('locale')).toBe('"en"')
    })

    it('does not reload for the language already shown', async () => {
      get.mockImplementation(async () => json({ locale: 'ja' }))
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
    })

    it('does not reload for a language this build lacks', async () => {
      get.mockImplementation(async () => json({ locale: 'xx' }))
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
    })

    it('does not reload when the browser refused to keep the language', async () => {
      get.mockImplementation(async () => json({ locale: 'en' }))
      failWrites = true
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
    })

    it('does not reload for any other setting', async () => {
      get.mockImplementation(async () => json({ browseLimit: 5, confirmDrop: false }))
      expect(await prefs.loadAccountPreferences('a', true)).toEqual({ reload: false })
    })
  })

  describe('sending', () => {
    it('keeps nothing and sends nothing after the logout, even before the next login', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.resetAccountPreferences()
      prefs.sharePreference({ sqlSafeMode: false })
      prefs.shareWorkspaceEntry('tables.recent.s', [])
      await prefs.sharePreferenceNow({ sqlSafeMode: false })
      await vi.advanceTimersByTimeAsync(1000)
      expect(put).not.toHaveBeenCalled()
      expect(putWorkspace).not.toHaveBeenCalled()
    })

    it('waits for the pause to end again whenever another change comes', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.sharePreference({ sqlSafeMode: false })
      await vi.advanceTimersByTimeAsync(300)
      prefs.sharePreference({ confirmDrop: false })
      await vi.advanceTimersByTimeAsync(300)
      expect(put).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(put).toHaveBeenCalledTimes(1)
      expect(put).toHaveBeenCalledWith({ json: { sqlSafeMode: false, confirmDrop: false } }, KEEPALIVE)
    })

    it('does the same for workspace entries', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.shareWorkspaceEntry('tables.recent.s', [1])
      await vi.advanceTimersByTimeAsync(300)
      prefs.shareWorkspaceEntry('tables.favorites.s', [2])
      await vi.advanceTimersByTimeAsync(300)
      expect(putWorkspace).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(putWorkspace).toHaveBeenCalledTimes(1)
      expect(putWorkspace).toHaveBeenCalledWith(
        { json: { set: { 'tables.recent.s': [1], 'tables.favorites.s': [2] }, remove: [] } },
        KEEPALIVE
      )
      // Only the workspace changed: no preferences request.
      expect(put).not.toHaveBeenCalled()
    })

    it('sends preferences alone at once, with keepalive, and workspace entries alone likewise', async () => {
      await prefs.loadAccountPreferences('a', true)
      await prefs.sharePreferenceNow({ theme: 'dark' })
      expect(put).toHaveBeenCalledWith({ json: { theme: 'dark' } }, KEEPALIVE)
      expect(putWorkspace).not.toHaveBeenCalled()
      prefs.shareWorkspaceEntry('tables.recent.s', [3])
      await vi.advanceTimersByTimeAsync(600)
      expect(putWorkspace).toHaveBeenCalledTimes(1)
      expect(put).toHaveBeenCalledTimes(1)
    })

    it('sends nothing when nothing changed', async () => {
      await prefs.loadAccountPreferences('a', true)
      await prefs.sharePreferenceNow({})
      expect(put).not.toHaveBeenCalled()
      expect(putWorkspace).not.toHaveBeenCalled()
    })

    it('sends a change that only removes an entry', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.shareWorkspaceEntry('tables.recent.s', null)
      await vi.advanceTimersByTimeAsync(600)
      expect(putWorkspace).toHaveBeenCalledWith({ json: { set: {}, remove: ['tables.recent.s'] } }, KEEPALIVE)
    })

    it('does not send what is sent already again', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.sharePreference({ theme: 'dark' })
      prefs.shareWorkspaceEntry('tables.recent.s', [1])
      await vi.advanceTimersByTimeAsync(600)
      await prefs.sharePreferenceNow({ confirmDrop: true })
      expect(put).toHaveBeenLastCalledWith({ json: { confirmDrop: true } }, KEEPALIVE)
      expect(putWorkspace).toHaveBeenCalledTimes(1)
    })
  })

  describe('workspace entries', () => {
    it('ignores a key the account does not keep', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.shareWorkspaceEntry('locale', 'ja')
      await vi.advanceTimersByTimeAsync(1000)
      expect(putWorkspace).not.toHaveBeenCalled()
    })

    it('ignores every change where the browser keeps the settings', async () => {
      await prefs.loadAccountPreferences('a', false)
      prefs.shareWorkspaceEntry('tables.recent.s', [1])
      prefs.sharePreference({ theme: 'dark' })
      await vi.advanceTimersByTimeAsync(1000)
      expect(putWorkspace).not.toHaveBeenCalled()
      expect(put).not.toHaveBeenCalled()
    })

    it('lets a later removal or setting of a key win over the earlier one', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.shareWorkspaceEntry('tables.recent.s', [1])
      prefs.shareWorkspaceEntry('tables.recent.s', null)
      prefs.shareWorkspaceEntry('tables.recent.s', null)
      prefs.shareWorkspaceEntry('tables.favorites.s', null)
      prefs.shareWorkspaceEntry('tables.favorites.s', [4])
      await vi.advanceTimersByTimeAsync(600)
      expect(putWorkspace).toHaveBeenCalledWith(
        { json: { set: { 'tables.favorites.s': [4] }, remove: ['tables.recent.s'] } },
        KEEPALIVE
      )
    })

    it('keeps a failed send for the next one, with what changed meanwhile winning', async () => {
      await prefs.loadAccountPreferences('a', true)
      let fail: (reason: unknown) => void = () => undefined
      putWorkspace.mockImplementationOnce(
        () =>
          new Promise<Response>((_, reject) => {
            fail = reject
          })
      )
      prefs.shareWorkspaceEntry('tables.favorites.s', [1])
      prefs.shareWorkspaceEntry('tables.recent.s', null)
      prefs.shareWorkspaceEntry('sidebar.collapsed', null)
      await vi.advanceTimersByTimeAsync(600)
      // While it is on its way: one key set again, another removed again.
      prefs.shareWorkspaceEntry('sidebar.collapsed', ['a'])
      prefs.shareWorkspaceEntry('tables.favorites.s', null)
      fail(new Error('network'))
      await vi.advanceTimersByTimeAsync(0)
      prefs.shareWorkspaceEntry('browse.display', 1)
      await vi.advanceTimersByTimeAsync(600)
      expect(putWorkspace).toHaveBeenCalledTimes(2)
      const sent = putWorkspace.mock.calls[1]?.[0] as { json: { set: Record<string, unknown>; remove: string[] } }
      expect(sent.json.set).toEqual({ 'sidebar.collapsed': ['a'], 'browse.display': 1 })
      expect(sent.json.remove.sort()).toEqual(['tables.favorites.s', 'tables.recent.s'])
    })
  })

  describe('between logins', () => {
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
      expect(putWorkspace.mock.calls[1]?.[0]).toEqual({
        json: { set: { 'tables.favorites.b': ['orders'] }, remove: [] },
      })
    })

    it('still keeps a failed preference send for the next one within the same login', async () => {
      await prefs.loadAccountPreferences('a', true)
      put.mockImplementationOnce(async () => Promise.reject(new Error('network')))
      prefs.sharePreference({ sqlSafeMode: false })
      await vi.advanceTimersByTimeAsync(600)
      prefs.sharePreference({ theme: 'dark' })
      await vi.advanceTimersByTimeAsync(600)
      expect(put.mock.calls[1]?.[0]).toEqual({ json: { sqlSafeMode: false, theme: 'dark' } })
    })
  })

  describe('clearing', () => {
    it('removes the named preferences from the account at once, and forgets them if still waiting', async () => {
      await prefs.loadAccountPreferences('a', true)
      prefs.sharePreference({ sqlSafeMode: false, confirmDrop: false })
      await prefs.clearSharedPreferences(['sqlSafeMode', 'browseLimit'])
      expect(put).toHaveBeenCalledTimes(1)
      expect(put).toHaveBeenCalledWith({ json: { sqlSafeMode: null, browseLimit: null } }, KEEPALIVE)
      // The pending timer was cancelled; what is left of the pending change goes with the next send.
      await vi.advanceTimersByTimeAsync(1000)
      expect(put).toHaveBeenCalledTimes(1)
      await prefs.sharePreferenceNow({})
      expect(put).toHaveBeenCalledTimes(2)
      expect(put).toHaveBeenLastCalledWith({ json: { confirmDrop: false } }, KEEPALIVE)
    })

    it('does nothing where the browser keeps the settings, and survives a failed request', async () => {
      await prefs.loadAccountPreferences('a', false)
      await prefs.clearSharedPreferences(['sqlSafeMode'])
      expect(put).not.toHaveBeenCalled()
      await prefs.loadAccountPreferences('b', true)
      put.mockImplementationOnce(async () => Promise.reject(new Error('down')))
      await expect(prefs.clearSharedPreferences(['sqlSafeMode'])).resolves.toBeUndefined()
    })
  })
})

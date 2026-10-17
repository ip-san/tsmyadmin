/**
 * User groups and the tabs their members see.
 */
import type { MyGroupTabs, UserGroup } from '@tsmyadmin/shared'
import { SavedQueryIdSchema, UserGroupBodySchema } from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { apiError } from '../lib/errors.ts'
import type { Logger } from '../lib/logging.ts'
import { safeJson } from '../lib/saved-items.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'
import type { SavedItem, Session } from '../session/store.ts'
import { sessionInfo } from '../session/store.ts'

function groups(items: SavedItem[]): UserGroup[] {
  return items.flatMap((item) => {
    const body = UserGroupBodySchema.safeParse(safeJson(item.body))
    return body.success ? [{ ...body.data, id: item.id, at: item.at }] : []
  })
}

/** Whether two member lists name the same accounts (absent: no group). */
function sameMembers(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const set = new Set(a)
  return set.size === new Set(b).size && b.every((name) => set.has(name))
}

/** Whether this session may manage every one of these accounts (asked once per name). */
async function managesAll(session: Session, names: readonly string[]): Promise<boolean> {
  for (const name of new Set(names)) if (!(await session.adapter.canManageAccount(name))) return false
  return true
}

/** The groups this session may see: those whose every member it can manage. */
async function visibleTo(session: Session, list: UserGroup[]): Promise<UserGroup[]> {
  const out: UserGroup[] = []
  for (const g of list) if (await managesAll(session, g.members)) out.push(g)
  return out
}

/**
 * phpMyAdmin's user groups: named sets of accounts, each hiding some tabs from its members. Shared by every
 * account of the server, so changing one is limited to an account that can manage every member it had and will
 * have — the same test that allows resetting another account's second factor. Reading the list is limited the
 * same way (it names accounts); an account always learns what its own groups hide.
 *
 * This hides tabs, nothing more: the API behind them answers exactly as before. docs/security.md says so.
 */
export function userGroupRoutes(cfg: SessionConfig, logger: Logger) {
  const unsupported = (c: Context) =>
    c.json(apiError('UNSUPPORTED', 'User groups need a persistent session store'), 400)
  const all = async (c: Context<AppEnv>) =>
    groups((await cfg.store.sharedItems?.list(c.get('session').config, 'usergroup')) ?? [])
  return new Hono<AppEnv>()
    .use('/user-groups', requireSession(cfg))
    .use('/user-groups/*', requireSession(cfg))
    .get('/user-groups/mine', async (c) => {
      const user = c.get('session').config.user
      const hidden = new Set((await all(c)).filter((g) => g.members.includes(user)).flatMap((g) => g.hiddenTabs))
      return c.json<MyGroupTabs>({ hiddenTabs: [...hidden].sort() })
    })
    .get('/user-groups', async (c) => c.json(await visibleTo(c.get('session'), await all(c))))
    .post('/user-groups', validate('json', UserGroupBodySchema), async (c) => {
      const store = cfg.store.sharedItems
      if (!store) return unsupported(c)
      const session = c.get('session')
      const group = c.req.valid('json')
      // Replacing a group takes the same right over the members it had as over the ones it gets.
      const before = (await all(c)).find((g) => g.name === group.name)
      if (!(await managesAll(session, [...group.members, ...(before?.members ?? [])]))) {
        return c.json(apiError('FORBIDDEN', 'This account cannot manage every member of that group'), 403)
      }
      // Written only over the group that right was checked against: if another account replaced it during the
      // check, this one may have no right over the members it has now.
      let replaced = false
      const items = await store.update(session.config, 'usergroup', group.name, (current) => {
        const now = current ? groups([current])[0] : undefined
        if (!sameMembers(now?.members, before?.members)) {
          replaced = true
          return null
        }
        return JSON.stringify(group)
      })
      if (replaced) {
        return c.json(apiError('CONFLICT', 'Another account changed that group at the same time; try again'), 409)
      }
      const saved = groups(items)
      logger.log('info', 'user_group.save', {
        requestId: c.get('requestId'),
        ...sessionInfo(session),
        group: group.name,
        members: group.members.length,
      })
      return c.json(await visibleTo(session, saved))
    })
    .delete('/user-groups/:id', validate('param', SavedQueryIdSchema), async (c) => {
      const store = cfg.store.sharedItems
      if (!store) return unsupported(c)
      const session = c.get('session')
      const target = (await all(c)).find((g) => g.id === c.req.valid('param').id)
      if (!target) return c.json(apiError('NOT_FOUND', 'No such group'), 404)
      if (!(await managesAll(session, target.members))) {
        return c.json(apiError('FORBIDDEN', 'This account cannot manage every member of that group'), 403)
      }
      // Deleted only while it still has the members that right was checked against, as a replacement is written.
      let replaced = false
      const items = await store.remove(session.config, 'usergroup', target.id, (current) => {
        replaced = !sameMembers(groups([current])[0]?.members, target.members)
        return !replaced
      })
      if (replaced) {
        return c.json(apiError('CONFLICT', 'Another account changed that group at the same time; try again'), 409)
      }
      const left = groups(items)
      logger.log('info', 'user_group.delete', {
        requestId: c.get('requestId'),
        ...sessionInfo(session),
        group: target.name,
      })
      return c.json(await visibleTo(session, left))
    })
}

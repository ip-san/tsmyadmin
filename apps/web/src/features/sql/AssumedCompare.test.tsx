import { cleanup, render, screen, within } from '@testing-library/react'
import type { ExplainResult } from '@tsmyadmin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { AssumedCompare } from './AssumedCompare.tsx'
import { type AssumedCompare as Compare, type CompareRow, candidatesKey } from './use-assumed-compare.ts'

const p = locale.plan
const posts = { table: 'posts', columns: ['user_id'], name: 'idx_posts_user_id', reason: 'perRow' as const }
const users = { table: 'users', columns: ['email'], name: 'idx_users_email', reason: 'filter' as const }
const planOf = (cost: number | null, assumed: string[] = []) =>
  ({ plan: { op: 'x', cost, children: [] }, raw: '', rawTruncated: false, assumed }) as unknown as ExplainResult
const before = planOf(1000)

const onShow = vi.fn()
const onBuild = vi.fn()
beforeEach(() => {
  onShow.mockClear()
  onBuild.mockClear()
})

function shown(
  rows: CompareRow[] | null,
  over: Partial<Compare> = {},
  props: { built?: boolean; waiting?: boolean } = {}
) {
  const compared: Compare = {
    rows,
    asked: rows ? candidatesKey([posts, users]) : null,
    running: false,
    compare: vi.fn(async () => undefined),
    ...over,
  }
  render(
    <AssumedCompare
      compared={compared}
      before={before}
      candidates={[posts, users]}
      onShow={onShow}
      onBuild={props.built === false ? undefined : onBuild}
      waiting={props.waiting ?? false}
    />
  )
  return { compared, group: screen.getByRole('region', { name: p.compareGroup }) }
}

afterEach(cleanup)

describe('AssumedCompare', () => {
  it('sets none, each alone and all together side by side, with what the server would use', () => {
    const { group } = shown([
      { indexes: [posts], result: planOf(400, []), error: null },
      { indexes: [users], result: planOf(100, ['idx_users_email']), error: null },
      { indexes: [posts, users], result: planOf(20, ['idx_users_email']), error: null },
    ])
    const rows = within(within(group).getByRole('table', { name: p.compareCaption }))
      .getAllByRole('row')
      .slice(1)
    expect(rows.map((r) => [...r.children].slice(0, 3).map((c) => c.textContent))).toEqual([
      [p.compareNone, p.compareCost(null, 1000), ''],
      [p.compareOne('idx_posts_user_id', 'posts', ['user_id']), p.compareCost(1000, 400), p.compareUnused],
      [
        p.compareOne('idx_users_email', 'users', ['email']),
        p.compareCost(1000, 100),
        p.compareUsed(['idx_users_email'], []),
      ],
      [p.compareAll, p.compareCost(1000, 20), p.compareUsed(['idx_users_email'], ['idx_posts_user_id'])],
    ])
    expect(within(group).getByRole('status').textContent).toBe(p.compareDone(3, 0))
  })

  it('says a plan that could not be estimated in its row, and why below', () => {
    const { group } = shown([
      { indexes: [posts], result: planOf(400), error: null },
      { indexes: [users], result: null, error: new Error('hypopg went away') },
    ])
    expect(within(group).getByRole('status').textContent).toBe(p.compareDone(1, 1))
    expect(within(group).getAllByRole('row')[3]?.textContent).toContain(p.compareFailed)
    expect(group.textContent).toContain('hypopg went away')
  })

  it('shows no rows asked of other candidates', () => {
    const { group } = shown([{ indexes: [posts], result: planOf(400), error: null }], { asked: 'other' })
    expect(within(group).queryByRole('table')).toBeNull()
    expect(within(group).getByRole('status').textContent).toBe('')
  })

  it('asks for the candidates once pressed, and not again while it runs (the button stays, its name the same)', () => {
    const { compared, group } = shown(null, { running: true })
    const button = within(group).getByRole('button', { name: p.compareRun })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    button.click()
    expect(compared.compare).not.toHaveBeenCalled()
    expect(within(group).getByRole('status').textContent).toBe(p.compareRunning)
    cleanup()
    const idle = shown(null)
    within(idle.group).getByRole('button', { name: p.compareRun }).click()
    expect(idle.compared.compare).toHaveBeenCalledWith([posts, users])
  })

  it("goes on from a candidate's own row: its plan as the server gave it, or building it; not from all together", () => {
    const alone = planOf(100, ['idx_users_email'])
    const { group } = shown([
      { indexes: [posts], result: null, error: new Error('no') },
      { indexes: [users], result: alone, error: null },
      { indexes: [posts, users], result: planOf(20), error: null },
    ])
    // A row that could not be estimated has no plan to show, but can still be built.
    expect(within(group).queryByRole('button', { name: p.compareShow('idx_posts_user_id') })).toBeNull()
    // The preview opens from here: the focus goes to the heading first, and comes back there when it closes.
    let focused: string | null | undefined
    onBuild.mockImplementationOnce(() => {
      focused = document.activeElement?.textContent
    })
    within(group)
      .getByRole('button', { name: p.compareBuild('idx_posts_user_id') })
      .click()
    expect(onBuild).toHaveBeenCalledWith(posts)
    expect(focused).toBe(p.compareGroup)
    within(group)
      .getByRole('button', { name: p.compareShow('idx_users_email') })
      .click()
    expect(onShow).toHaveBeenCalledWith(users, alone)
    const together = within(group).getAllByRole('row')[4]
    expect(together && within(together).queryAllByRole('button')).toEqual([])
  })

  it('offers no build before the statement is measured, and its buttons wait while something else is under way', () => {
    const rows = [{ indexes: [users], result: planOf(100), error: null }]
    const before = shown(rows, {}, { built: false })
    expect(within(before.group).queryByRole('button', { name: p.compareBuild('idx_users_email') })).toBeNull()
    cleanup()
    const { group } = shown(rows, {}, { waiting: true })
    for (const name of [p.compareShow('idx_users_email'), p.compareBuild('idx_users_email')]) {
      const button = within(group).getByRole('button', { name })
      expect(button.getAttribute('aria-disabled')).toBe('true')
      button.click()
    }
    expect(onShow).not.toHaveBeenCalled()
    expect(onBuild).not.toHaveBeenCalled()
  })
})

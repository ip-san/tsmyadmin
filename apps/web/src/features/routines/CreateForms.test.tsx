import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CreateEventForm, toMoment } from './CreateEventForm.tsx'
import { CreateRoutineForm } from './CreateRoutineForm.tsx'
import { CreateTriggerForm } from './CreateTriggerForm.tsx'

describe('CreateRoutineForm', () => {
  it('builds a function with its parameters, return type and body', async () => {
    const onSubmit = vi.fn()
    render(<CreateRoutineForm dialect="mysql" onSubmit={onSubmit} />)
    await userEvent.selectOptions(screen.getByLabelText('種類'), 'function')
    await userEvent.type(screen.getByLabelText('名前'), 'add_one')
    await userEvent.click(screen.getByRole('button', { name: '引数を追加' }))
    await userEvent.type(screen.getByLabelText('引数 1 の名前'), 'n')
    // An empty parameter row is left out rather than sent half-filled.
    await userEvent.click(screen.getByRole('button', { name: '引数を追加' }))
    await userEvent.clear(screen.getByLabelText('引数 2 の型'))
    await userEvent.click(screen.getByRole('button', { name: /SQL を確認$/ }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'createRoutine',
        kind: 'function',
        name: 'add_one',
        params: [{ mode: 'IN', name: 'n', type: 'INT' }],
        returns: 'INT',
        body: 'BEGIN\n  RETURN NULL;\nEND',
      })
    )
  })

  it('offers only IN for a MySQL function, and OUT / INOUT for a procedure', async () => {
    render(<CreateRoutineForm dialect="mysql" onSubmit={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '引数を追加' }))
    expect(screen.getByRole('option', { name: 'INOUT' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('種類'), 'function')
    expect(screen.queryByRole('option', { name: 'INOUT' })).not.toBeInTheDocument()
  })
})

describe('CreateTriggerForm', () => {
  it('uses the table of the page it is on, and the dialect’s body shape', async () => {
    const onSubmit = vi.fn()
    render(<CreateTriggerForm dialect="postgres" tables={[]} table="users" onSubmit={onSubmit} />)
    expect(screen.queryByLabelText('テーブル')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('名前'), 'touch')
    await userEvent.click(screen.getByRole('button', { name: /SQL を確認$/ }))
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ op: 'createTrigger', name: 'touch', table: 'users' })
    expect(onSubmit.mock.calls[0]?.[0].body).toMatch(/RETURN NEW;/)
  })
})

describe('CreateEventForm', () => {
  it('reads a datetime-local value as the scheduler’s moment', () => {
    expect(toMoment('2026-09-18T09:30')).toBe('2026-09-18 09:30:00')
    expect(toMoment('2026-09-18T09:30:15')).toBe('2026-09-18 09:30:15')
    expect(toMoment('')).toBeUndefined()
  })

  it('builds a repeating schedule, leaving out the optional bounds when they are empty', async () => {
    const onSubmit = vi.fn()
    render(<CreateEventForm onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('名前'), 'prune')
    await userEvent.selectOptions(screen.getByLabelText('単位'), 'HOUR')
    await userEvent.click(screen.getByRole('button', { name: /SQL を確認$/ }))
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      op: 'createEvent',
      name: 'prune',
      schedule: { kind: 'every', interval: 1, unit: 'HOUR' },
      enabled: true,
    })
    expect(onSubmit.mock.calls[0]?.[0].schedule).not.toHaveProperty('starts')
  })
})

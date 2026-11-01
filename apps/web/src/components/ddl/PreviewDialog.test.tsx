import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StatementResult } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { type PreviewFlowConfig, usePreviewFlow } from '@/lib/preview-flow.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const d = locale.ddl
const ok = (statement: number): StatementResult => ({
  kind: 'affected',
  statement,
  sql: `ALTER ${statement}`,
  affectedRows: 0,
  durationMs: 1,
})
const failed: StatementResult = { kind: 'error', statement: 1, sql: 'ALTER 1', message: 'canceling statement' }

/** The run's answer, given when the test says so. */
let finish: (r: { results: StatementResult[] }) => void
let fail: (err: unknown) => void
const execute = vi.fn(
  (_op: string, _sql: string[], _queryId: string) =>
    new Promise<{ results: StatementResult[] }>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
)
let stopAnswer: () => Promise<boolean>
const stop = vi.fn((_queryId: string) => stopAnswer())
const onSuccess = vi.fn()

function Harness({ stoppable = true }: { stoppable?: boolean }) {
  const config: PreviewFlowConfig<string> = {
    preview: async () => ({ sql: ['ALTER 0', 'ALTER 1'] }),
    execute,
    onSuccess,
    ...(stoppable ? { stop } : {}),
  }
  const flow = usePreviewFlow(config)
  return (
    <>
      <button type="button" onClick={() => flow.preview('build')}>
        open
      </button>
      <PreviewDialog
        flow={flow}
        title={() => 'Build'}
        destructive={() => false}
        hint="hint"
        successMessage={() => 'built'}
      />
    </>
  )
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
  }
})
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  execute.mockClear()
  stop.mockClear()
  onSuccess.mockClear()
  stopAnswer = async () => true
})
afterEach(cleanup)

/** Opens the preview and runs it: the run waits for the test. */
async function running(stoppable = true) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness stoppable={stoppable} />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  fireEvent.click(await screen.findByRole('button', { name: d.execute }))
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
}
const stopButton = () => screen.findByRole('button', { name: d.stop })

describe('PreviewDialog, stopping a run', () => {
  it('stops the run by its own id, once however often pressed, and says it is stopping', async () => {
    let answer: (v: boolean) => void = () => undefined
    stopAnswer = () => new Promise((resolve) => (answer = resolve))
    await running()
    const button = await stopButton()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(execute.mock.calls[0]?.[2])
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(d.stopping).getAttribute('role')).toBe('status')
    await act(async () => answer(true))
    await act(async () => finish({ results: [ok(0), failed] }))
    // Stopped, not failed: the server's error for the stopped statement is not shown as a failure.
    const said = await screen.findByRole('alert')
    expect(said.textContent).toBe(d.stopped)
    expect(screen.queryByText(d.failedStatement, { exact: false })).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    // The stop button went with the run: the focus is on what happened.
    expect(screen.queryByRole('button', { name: d.stop })).toBeNull()
    expect(document.activeElement?.contains(said)).toBe(true)
  })

  it('is stopped where the stop came between two statements, though no statement failed', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0)] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped)
    // Not done: the follow-up (measuring an index tried, say) does not run.
    expect(onSuccess).not.toHaveBeenCalled()
    expect(screen.queryByText('built')).toBeNull()
  })

  it('is stopped where the request itself ended in an error after the stop', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => fail(new Error('aborted')))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped)
    expect(screen.queryByText('aborted')).toBeNull()
  })

  it('is done where the run had ended before the stop reached it', async () => {
    stopAnswer = async () => false
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
    expect(screen.queryByText(d.stopped)).toBeNull()
  })

  it('says why a stop did not reach the server, and lets it be asked again', async () => {
    stopAnswer = async () => {
      throw new Error('network down')
    }
    await running()
    fireEvent.click(await stopButton())
    expect(await screen.findByText('network down')).toBeTruthy()
    const button = await stopButton()
    await vi.waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull())
    stopAnswer = async () => true
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(2)
    await act(async () => finish({ results: [ok(0)] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped)
  })

  it('offers no stop where the flow cannot stop, and none before the run', async () => {
    await running(false)
    expect(screen.queryByRole('button', { name: d.stop })).toBeNull()
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it('starts a run anew: a stop before is not taken for this one', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0)] }))
    await screen.findByRole('alert')
    // Previewed and run again: done this time.
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.queryByText(d.stopped)).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: d.execute }))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(execute.mock.calls[1]?.[2]).not.toBe(execute.mock.calls[0]?.[2])
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })
  it('is stopped where the answer to the stop did not come back and the script ended short without an error', async () => {
    stopAnswer = async () => {
      throw new Error('network down')
    }
    await running()
    fireEvent.click(await stopButton())
    await screen.findByText('network down')
    await act(async () => finish({ results: [ok(0)] }))
    expect(await screen.findByText(d.stopped)).toBeTruthy()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('is done at once where every statement answered, without waiting for the answer to the stop', async () => {
    stopAnswer = () => new Promise(() => undefined)
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
  })

  it('puts away the failure of the run before as a run starts', async () => {
    await running()
    await act(async () => finish({ results: [ok(0), failed] }))
    expect(await screen.findByText(d.failedStatement, { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: d.execute }))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(d.failedStatement, { exact: false })).toBeNull()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0)] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped)
    expect(screen.queryByText(d.failedStatement, { exact: false })).toBeNull()
  })
})

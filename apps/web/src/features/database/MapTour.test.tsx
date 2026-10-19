import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RelationDef } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { relation } from '@/test/schema-fixtures.ts'
import type { DatabaseMap } from './database-map.ts'
import type { JoinEnds } from './JoinPath.tsx'
import { MapTour } from './MapTour.tsx'

const t = locale.mapTour
const g = locale.tour

/** What the mocked API answers, set afresh for each test. */
let keys: RelationDef[] | Error

vi.mock('@/lib/session.ts', () => ({ useDialect: () => 'mysql' }))
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => ['users', 'orders', 'lines'].map((name) => ({ name, kind: 'table' })),
  }),
  foreignKeysQuery: () => ({
    queryKey: ['keys'],
    queryFn: async () => {
      if (keys instanceof Error) throw keys
      return keys
    },
  }),
}))

const map: DatabaseMap = {
  tables: 3,
  views: 0,
  roles: { master: ['users'], middle: ['orders'], detail: ['lines'], junction: [], tree: [], isolated: [] },
  hubs: [{ table: 'users', referredBy: 1 }],
  noPrimaryKey: [],
  unindexedKeys: [],
  keyTypes: [],
  nameTypes: [],
}

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

beforeEach(() => {
  keys = [relation('orders', ['user_id'], 'users'), relation('lines', ['order_id'], 'orders')]
  // Less motion: nothing plays by itself, and the camera does not move over time.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }))
})

afterEach(() => vi.unstubAllGlobals())

function mount(ends: JoinEnds = { from: undefined, to: undefined }) {
  const onClose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MapTour db="shop" schema={undefined} map={map} ends={ends} onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose, dialog: screen.getByRole('dialog', { name: t.dialog('shop') }) }
}

const caption = () => screen.getByRole('heading', { level: 3 })

describe('MapTour', () => {
  it('reads the tables and keys, then opens on the whole database', async () => {
    mount()
    expect(screen.getByRole('status')).toHaveTextContent(g.reading)
    expect(await screen.findByRole('img', { name: t.diagram('shop') })).toBeInTheDocument()
    expect(caption()).toHaveTextContent('shop')
    expect(screen.getByText(t.overview(3, 2))).toBeInTheDocument()
    // Overview, three roles, one hub, the end.
    expect(screen.getByText(g.sceneOf(1, 6))).toBeInTheDocument()
  })

  it("moves with the arrow keys, a clicker's Page keys, the space bar, and Home and End", async () => {
    const { dialog } = mount()
    await screen.findByRole('img')
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    expect(caption()).toHaveTextContent(t.roleTitle(t.roles.master, 1))
    fireEvent.keyDown(dialog, { key: 'PageDown' })
    expect(caption()).toHaveTextContent(t.roleTitle(t.roles.middle, 1))
    fireEvent.keyDown(dialog, { key: ' ' })
    expect(caption()).toHaveTextContent(t.roleTitle(t.roles.detail, 1))
    fireEvent.keyDown(dialog, { key: 'PageUp' })
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' })
    expect(caption()).toHaveTextContent(t.roleTitle(t.roles.master, 1))
    fireEvent.keyDown(dialog, { key: 'End' })
    expect(caption()).toHaveTextContent(t.endTitle)
    fireEvent.keyDown(dialog, { key: 'Home' })
    expect(caption()).toHaveTextContent('shop')
    // A key with a modifier is the browser's.
    fireEvent.keyDown(dialog, { key: 'ArrowRight', metaKey: true })
    expect(caption()).toHaveTextContent('shop')
  })

  it('leaves a focused button its own space bar', async () => {
    mount()
    await screen.findByRole('img')
    fireEvent.keyDown(screen.getByRole('button', { name: g.next }), { key: ' ' })
    expect(caption()).toHaveTextContent('shop')
  })

  it('plays and pauses with P, and from its button', async () => {
    const { dialog } = mount()
    await screen.findByRole('img')
    fireEvent.keyDown(dialog, { key: 'p' })
    expect(screen.getByRole('button', { name: g.pause })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: g.pause }))
    expect(screen.getByRole('button', { name: g.play })).toBeInTheDocument()
  })

  it('names only the colours the scene draws, for what they mean on the tour', async () => {
    const { dialog } = mount()
    await screen.findByRole('img')
    const legend = () => screen.getByText(locale.schemaDiagram.legend).closest('figure')
    expect(legend()?.querySelectorAll('li')).toHaveLength(0)
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    expect(legend()).toHaveTextContent(t.tones.focus)
    expect(legend()).not.toHaveTextContent(t.tones.index)
    // The hub, and the tables that point at it.
    fireEvent.keyDown(dialog, { key: 'End' })
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' })
    expect(legend()).toHaveTextContent(`${t.tones.focus}${t.tones.index}`)
  })

  it('jumps to a scene picked on the bar, which marks the one shown', async () => {
    mount()
    await screen.findByRole('img')
    const bar = screen.getByRole('list', { name: g.scenes })
    const hub = within(bar).getByRole('button', { name: g.goTo(5, t.hubTitle('users', 1)) })
    fireEvent.click(hub)
    expect(caption()).toHaveTextContent(t.hubTitle('users', 1))
    expect(hub).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: g.next })).toBeEnabled()
    fireEvent.click(within(bar).getAllByRole('button').at(-1) as HTMLElement)
    expect(screen.getByRole('button', { name: g.next })).toBeDisabled()
  })

  it('walks the path between the two tables chosen on the map', async () => {
    const { dialog } = mount({ from: 'lines', to: 'users' })
    await screen.findByRole('img')
    for (let i = 0; i < 5; i++) fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    expect(caption()).toHaveTextContent(t.pathTitle('lines', 'users'))
    expect(screen.getByText(`${t.pathStep(1, 2)}${t.pathKey('lines', 'order_id', 'orders', 'id')}`)).toBeInTheDocument()
  })

  it('asks the browser for the whole screen with F, and gives it back', async () => {
    const { dialog } = mount()
    await screen.findByRole('img')
    const request = vi.fn(async () => undefined)
    dialog.requestFullscreen = request
    fireEvent.keyDown(dialog, { key: 'f' })
    expect(request).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: dialog })
    const exit = vi.fn(async () => undefined)
    document.exitFullscreen = exit
    fireEvent(document, new Event('fullscreenchange'))
    expect(screen.getByRole('button', { name: g.fullscreen })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: g.fullscreen }))
    expect(exit).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
  })

  it('closes from its button, and gives the focus back to what opened it', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { onClose } = mount()
    fireEvent.click(screen.getByRole('button', { name: g.close }))
    expect(onClose).toHaveBeenCalledTimes(1)
    screen.getByRole('button', { name: g.close, hidden: true }).focus()
    cleanup()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('says why the keys could not be read, and reads them again', async () => {
    keys = new Error('cannot read keys')
    mount()
    expect(await screen.findByText(/cannot read keys/)).toBeInTheDocument()
    keys = []
    fireEvent.click(screen.getByRole('button', { name: locale.common.retry }))
    expect(await screen.findByRole('img')).toBeInTheDocument()
  })
})

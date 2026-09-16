import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { describeSessionStoreConformance } from './conformance.ts'
import { MemorySessionStore } from './store.ts'

// Everything this store owes its callers is the shared contract; it has no persistence of its own to test.
describeSessionStoreConformance(
  'memory',
  (options) =>
    new MemorySessionStore({ ...options, adapterFactory: options.adapterFactory ?? (() => new FakeAdapter()) })
)

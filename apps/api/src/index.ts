import { Hono } from 'hono'

const app = new Hono().get('/api/health', (c) => c.json({ ok: true }))

export type AppType = typeof app

export default {
  port: Number(process.env.API_PORT ?? 3100),
  fetch: app.fetch,
}

import type { ServerPreset } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { connectionEndpoints, connectionSnippets } from './connection-info.ts'

const mysql: ServerPreset = {
  name: 'docker: shop/mysql',
  dialect: 'mysql',
  host: '127.0.0.1',
  port: 13306,
  database: 'shop',
  docker: { service: 'mysql', project: 'shop', privatePort: 3306, user: 'app' },
}
const postgres: ServerPreset = {
  name: 'docker: shop/pgsql',
  dialect: 'postgres',
  host: '127.0.0.1',
  port: 15432,
  docker: { service: 'pgsql', project: 'shop', privatePort: 5432, user: 'postgres' },
}

describe('connectionEndpoints', () => {
  it('gives the host, same-network and other-network addresses of a Compose container', () => {
    expect(connectionEndpoints(mysql)).toEqual([
      { viewpoint: 'host', host: '127.0.0.1', port: 13306 },
      { viewpoint: 'sameNetwork', host: 'mysql', port: 3306 },
      { viewpoint: 'otherNetwork', host: 'host.docker.internal', port: 13306 },
    ])
  })

  it('reaches the published port on 127.0.0.1 from the host when tsmyadmin itself runs in a container', () => {
    expect(connectionEndpoints({ ...mysql, host: 'host.docker.internal' })[0]).toEqual({
      viewpoint: 'host',
      host: '127.0.0.1',
      port: 13306,
    })
    // A connect host someone named (TSMYADMIN_DOCKER_CONNECT_HOST) is kept.
    expect(connectionEndpoints({ ...mysql, host: '192.168.1.5' })[0]?.host).toBe('192.168.1.5')
  })

  it('has no same-network address without a Compose service, and nothing for a preset not from Docker', () => {
    const plain = { ...mysql, docker: { privatePort: 3306 } }
    expect(connectionEndpoints(plain).map((e) => e.viewpoint)).toEqual(['host', 'otherNetwork'])
    const { docker: _, ...operator } = mysql
    expect(connectionEndpoints(operator)).toEqual([])
  })
})

describe('connectionSnippets', () => {
  it('builds a MySQL URL, the .env line and Laravel lines with a placeholder for the password', () => {
    const [, sameNetwork] = connectionEndpoints(mysql)
    if (!sameNetwork) throw new Error('no endpoint')
    expect(connectionSnippets(mysql, sameNetwork)).toEqual({
      address: 'mysql:3306',
      databaseUrl: 'mysql://app:<password>@mysql:3306/shop',
      env: 'DATABASE_URL=mysql://app:<password>@mysql:3306/shop',
      laravelEnv: [
        'DB_CONNECTION=mysql',
        'DB_HOST=mysql',
        'DB_PORT=3306',
        'DB_DATABASE=shop',
        'DB_USERNAME=app',
        'DB_PASSWORD=<password>',
      ].join('\n'),
    })
  })

  it('uses postgresql:// and pgsql, and the database named after the user when the container named none', () => {
    const [host] = connectionEndpoints(postgres)
    if (!host) throw new Error('no endpoint')
    const s = connectionSnippets(postgres, host)
    expect(s.databaseUrl).toBe('postgresql://postgres:<password>@127.0.0.1:15432/postgres')
    expect(s.laravelEnv).toContain('DB_CONNECTION=pgsql')
    expect(s.laravelEnv).toContain('DB_DATABASE=postgres')
  })

  it('leaves the MySQL database out when there is none, and puts a placeholder for an unknown user', () => {
    const { database: _, ...noDatabase } = mysql
    const preset = { ...noDatabase, docker: { privatePort: 3306 } }
    const s = connectionSnippets(preset, { viewpoint: 'host', host: '127.0.0.1', port: 3306 })
    expect(s.databaseUrl).toBe('mysql://<user>:<password>@127.0.0.1:3306')
    expect(s.laravelEnv).toContain('DB_DATABASE=\n')
    expect(s.laravelEnv).toContain('DB_USERNAME=<user>')
  })

  it('escapes what a URL cannot carry, and brackets an IPv6 host', () => {
    const preset = { ...mysql, database: 'my db', docker: { privatePort: 3306, user: 'a@b' } }
    const s = connectionSnippets(preset, { viewpoint: 'host', host: '::1', port: 3306 })
    expect(s.databaseUrl).toBe('mysql://a%40b:<password>@[::1]:3306/my%20db')
    expect(s.address).toBe('[::1]:3306')
    // .env keeps the names as they are: they are not in a URL there.
    expect(s.laravelEnv).toContain('DB_USERNAME=a@b')
  })

  it('has the placeholder wherever a password goes: the URL, the .env line and DB_PASSWORD', () => {
    for (const preset of [mysql, postgres]) {
      for (const endpoint of connectionEndpoints(preset)) {
        const text = Object.values(connectionSnippets(preset, endpoint)).join('\n')
        expect(text.match(/<password>/g)?.length).toBe(3)
      }
    }
  })
})

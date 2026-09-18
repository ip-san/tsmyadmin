import { QueryClient } from '@tanstack/react-query'
import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { Route } from './_app.tsx'

type BeforeLoad = (args: {
  context: { queryClient: QueryClient }
  location: { pathname: string; href: string }
}) => unknown

async function guard(secondFactor: string, pathname: string) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['session'], { dialect: 'mysql', host: 'h', port: 3306, user: 'u', secondFactor })
  const beforeLoad = Route.options.beforeLoad as unknown as BeforeLoad
  try {
    await beforeLoad({ context: { queryClient }, location: { pathname, href: pathname } })
    return null
  } catch (err) {
    if (isRedirect(err)) return err.options.to
    throw err
  }
}

describe('the app layout guard', () => {
  it('sends an account that must enrol to the security page, and lets it stay there', async () => {
    // Every other page would only show the API refusing it with SECOND_FACTOR_REQUIRED.
    expect(await guard('enrollment_required', '/')).toBe('/security')
    expect(await guard('enrollment_required', '/db/shop')).toBe('/security')
    expect(await guard('enrollment_required', '/security')).toBeNull()
  })

  it('lets everyone else through', async () => {
    expect(await guard('none', '/')).toBeNull()
    expect(await guard('enrolled', '/db/shop')).toBeNull()
  })
})

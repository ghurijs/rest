import { createApp, defineSettings, type GhuriApp, type RequestUser, type UrlPatterns } from '@ghuri/core'
import { setupTestDatabase, type TestBackend, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import type { RestFrameworkSettings } from '../src/index'
import { APIClient } from '../src/testing'
import { allModels } from './models'

export interface ApiHarness {
  app: GhuriApp
  db: TestDatabase
  client: APIClient
  env: Record<string, unknown>
}

/** createApp + test database + APIClient, sharing one env object so requests see the test DB. */
export async function makeApi(opts: {
  urls: UrlPatterns
  backend?: TestBackend
  rest?: Partial<RestFrameworkSettings>
  settings?: Record<string, unknown>
  models?: any[]
}): Promise<ApiHarness> {
  const env: Record<string, unknown> = {}
  const settings = defineSettings(() => ({
    SECRET_KEY: 'test-secret',
    DEBUG: false,
    INSTALLED_APPS: [],
    ROOT_URLCONF: opts.urls,
    REST_FRAMEWORK: opts.rest ?? {},
    ...(opts.settings ?? {}),
  }))
  const app = createApp(settings, { checks: false })
  await app.setup(env)
  const db = await setupTestDatabase({ using: opts.backend ?? 'sqlite', models: opts.models ?? allModels })
  const client = new APIClient(app, { env, defaultFormat: 'json' })
  return { app, db, client, env }
}

/** Per-describe harness, flushed before each test. */
export function useApi(factory: () => Parameters<typeof makeApi>[0]): ApiHarness {
  const h = {} as ApiHarness
  beforeAll(async () => {
    Object.assign(h, await makeApi(factory()))
  }, 60_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    await h.db.flush()
    h.client.forceAuthenticate(null)
    h.client.credentials()
  })
  return h
}

/** A RequestUser for tests (no auth package). */
export function fakeUser(
  opts: {
    pk?: number
    username?: string
    isStaff?: boolean
    perms?: string[]
    objectPerms?: (perm: string, obj: any) => boolean
  } = {},
): RequestUser {
  const perms = new Set(opts.perms ?? [])
  return {
    pk: opts.pk ?? 1,
    username: opts.username ?? 'alice',
    isAuthenticated: true,
    isAnonymous: false,
    isActive: true,
    isStaff: opts.isStaff ?? false,
    isSuperuser: false,
    async hasPerm(perm: string, obj?: unknown) {
      if (obj !== undefined && opts.objectPerms) return opts.objectPerms(perm, obj)
      return perms.has(perm)
    },
  }
}

export const backends: TestBackend[] = (process.env.GHURI_TEST_BACKENDS?.split(',') as
  | TestBackend[]
  | undefined) ?? ['sqlite', 'pglite']

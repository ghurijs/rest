import { CsrfFailure, enforceCsrf, getUser, type RequestUser } from '@ghuri/core'
import type { Context } from 'hono'
import { PermissionDenied } from './exceptions'

/**
 * The authentication contract (DRF's `BaseAuthentication`). Concrete classes (`SessionAuthentication`,
 * `TokenAuthentication`, `JWTAuthentication`, `BasicAuthentication`) live in `@ghuri/auth/rest` and implement
 * this structurally; they are instantiated with `new Cls()` for every request.
 *
 * - return `[user, auth]` when the credentials are valid (`auth` is the token / payload, may be null),
 * - return `null` when this scheme was not used (the next class is tried),
 * - throw `AuthenticationFailed` when credentials were supplied but are invalid.
 *
 * `authenticateHeader(c)` returns the `WWW-Authenticate` value used for 401 responses; without it,
 * unauthenticated requests get 403.
 */
export interface BaseAuthentication {
  authenticate(c: Context): Promise<[RequestUser, unknown] | null>
  authenticateHeader?(c: Context): string | undefined
}

export type AuthenticationClass = new () => BaseAuthentication

/**
 * Uses the user that `AuthenticationMiddleware` (from `@ghuri/auth`, or any middleware calling core's
 * `setUser`) attached to the request. Like DRF's `SessionAuthentication`, unsafe requests from an
 * authenticated user must pass CSRF validation (API views themselves are CSRF-exempt).
 * This is the default `DEFAULT_AUTHENTICATION_CLASSES` because it needs nothing beyond `@ghuri/core`.
 */
export class MiddlewareAuthentication implements BaseAuthentication {
  async authenticate(c: Context): Promise<[RequestUser, unknown] | null> {
    const user = getUser(c)
    if (!user?.isAuthenticated || user.isActive === false) return null
    await this.enforceCsrf(c)
    return [user, null]
  }

  async enforceCsrf(c: Context): Promise<void> {
    try {
      await enforceCsrf(c)
    } catch (err) {
      if (err instanceof CsrfFailure) throw new PermissionDenied(`CSRF Failed: ${err.reason}`)
      throw err
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Forced authentication (test helper `APIClient.forceAuthenticate()`)
// ---------------------------------------------------------------------------------------------

/** Header carrying a forced-authentication id; only ids registered in-process by test code are honored. */
export const FORCE_AUTH_HEADER = 'x-ghuri-rest-force-auth'

const FORCED_KEY = Symbol.for('ghuri.rest.forcedAuth')
/** @internal id → [user, token]. Filled only by `@ghuri/rest/testing`. */
const g = globalThis as any
if (!g[FORCED_KEY]) g[FORCED_KEY] = new Map()
export const forcedAuthRegistry: Map<string, [RequestUser | null, unknown]> = g[FORCED_KEY]

/** DRF's `ForcedAuthentication`. */
export class ForcedAuthentication implements BaseAuthentication {
  constructor(
    readonly forceUser: RequestUser | null,
    readonly forceToken: unknown = null,
  ) {}
  async authenticate(): Promise<[RequestUser, unknown] | null> {
    return this.forceUser ? [this.forceUser, this.forceToken] : null
  }
}

// @ghuri/rest/testing — DRF-style API test client on top of @ghuri/core/testing.
import type { RequestUser } from '@ghuri/core'
import {
  createTestClient,
  type RequestOptions,
  type TestableApp,
  type TestClient,
  type TestClientOptions,
  type TestResponse,
} from '@ghuri/core/testing'
import { FORCE_AUTH_HEADER, forcedAuthRegistry } from './authentication'
import { apiSettings } from './settings'

export type RequestFormat = 'json' | 'multipart' | 'form'

export interface APIRequestOptions extends Omit<RequestOptions, 'json' | 'form'> {
  /** Body encoding (default `REST_FRAMEWORK.TEST_REQUEST_DEFAULT_FORMAT`, i.e. `'multipart'`). */
  format?: RequestFormat
}

/** A test response with the parsed body as `data` (DRF's `response.data`). */
export interface APITestResponse extends TestResponse {
  /** Parsed JSON body (undefined for non-JSON responses). */
  data: any
}

function defaultFormat(): RequestFormat {
  try {
    return apiSettings.TEST_REQUEST_DEFAULT_FORMAT ?? 'multipart'
  } catch {
    return 'multipart'
  }
}

/**
 * DRF's `APIClient`: `get(path, query)`, `post(path, data, { format })`, `forceAuthenticate(user)`,
 * `credentials({ Authorization: 'Token …' })`. Responses carry `data` (parsed JSON).
 *
 * ```ts
 * const client = new APIClient(app)
 * client.forceAuthenticate(user)
 * const res = await client.post('/api/posts/', { title: 'Hi' }, { format: 'json' })
 * expect(res.status).toBe(201); expect(res.data.title).toBe('Hi')
 * ```
 */
export class APIClient {
  readonly client: TestClient
  defaultFormat?: RequestFormat
  _credentials: Record<string, string> = {}
  _forceId?: string

  constructor(
    app: TestableApp | TestClient,
    opts: TestClientOptions & { defaultFormat?: RequestFormat } = {},
  ) {
    this.client =
      typeof (app as TestClient).request === 'function' && 'cookies' in (app as object)
        ? (app as TestClient)
        : createTestClient(app as TestableApp, opts)
    this.defaultFormat = opts.defaultFormat
  }

  /** Authenticate every following request as `user` (null to stop), bypassing authentication classes. */
  forceAuthenticate(user: RequestUser | null = null, token: unknown = null): void {
    if (this._forceId) forcedAuthRegistry.delete(this._forceId)
    this._forceId = undefined
    if (user === null && token === null) return
    this._forceId = crypto.randomUUID()
    forcedAuthRegistry.set(this._forceId, [user, token])
  }

  /** Headers sent with every following request (`credentials()` with no args clears them). */
  credentials(headers: Record<string, string> = {}): void {
    this._credentials = { ...headers }
  }

  logout(): Promise<void> {
    this.forceAuthenticate(null)
    this._credentials = {}
    return this.client.logout().catch(() => this.client.clearCookies())
  }

  buildOptions(data: unknown, opts: APIRequestOptions = {}): RequestOptions {
    const { format, headers, ...rest } = opts
    const out: RequestOptions = { ...rest, headers: { ...this._credentials, ...(headers ?? {}) } }
    if (this._forceId) out.headers![FORCE_AUTH_HEADER] = this._forceId
    if (data !== undefined) {
      const fmt = format ?? this.defaultFormat ?? defaultFormat()
      if (fmt === 'json' || data === null || Array.isArray(data) || typeof data !== 'object') out.json = data
      else if (fmt === 'multipart') {
        const fd = new FormData()
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          for (const x of Array.isArray(v) ? v : [v]) {
            if (x === undefined || x === null) continue
            fd.append(k, x instanceof Blob ? x : typeof x === 'object' ? JSON.stringify(x) : String(x))
          }
        }
        out.form = fd
      } else out.form = data as Record<string, unknown>
    }
    return out
  }

  async wrap(res: TestResponse): Promise<APITestResponse> {
    let data: any
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('json')) {
      try {
        data = await res.clone().json()
      } catch {
        data = undefined
      }
    }
    return Object.assign(res, { data }) as APITestResponse
  }

  async get(
    path: string,
    query?: Record<string, unknown>,
    opts: APIRequestOptions = {},
  ): Promise<APITestResponse> {
    return this.wrap(
      await this.client.get(path, { ...this.buildOptions(undefined, opts), query: query ?? opts.query }),
    )
  }

  async head(
    path: string,
    query?: Record<string, unknown>,
    opts: APIRequestOptions = {},
  ): Promise<APITestResponse> {
    return this.wrap(
      await this.client.head(path, { ...this.buildOptions(undefined, opts), query: query ?? opts.query }),
    )
  }

  async options(path: string, opts: APIRequestOptions = {}): Promise<APITestResponse> {
    return this.wrap(await this.client.options(path, this.buildOptions(undefined, opts)))
  }

  async post(path: string, data?: unknown, opts: APIRequestOptions = {}): Promise<APITestResponse> {
    return this.wrap(await this.client.post(path, this.buildOptions(data, opts)))
  }

  async put(path: string, data?: unknown, opts: APIRequestOptions = {}): Promise<APITestResponse> {
    return this.wrap(await this.client.put(path, this.buildOptions(data, opts)))
  }

  async patch(path: string, data?: unknown, opts: APIRequestOptions = {}): Promise<APITestResponse> {
    return this.wrap(await this.client.patch(path, this.buildOptions(data, opts)))
  }

  async delete(path: string, data?: unknown, opts: APIRequestOptions = {}): Promise<APITestResponse> {
    return this.wrap(await this.client.delete(path, this.buildOptions(data, opts)))
  }
}

/** `createAPIClient(app, { env })`. */
export function createAPIClient(
  app: TestableApp,
  opts: TestClientOptions & { defaultFormat?: RequestFormat } = {},
): APIClient {
  return new APIClient(app, opts)
}

export { FORCE_AUTH_HEADER }

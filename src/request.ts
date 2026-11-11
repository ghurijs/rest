import { getHost, isSecure, type RequestUser, setUser } from '@ghuri/core'
import type { Context } from 'hono'
import {
  type BaseAuthentication,
  FORCE_AUTH_HEADER,
  ForcedAuthentication,
  forcedAuthRegistry,
} from './authentication'
import { APIException, UnsupportedMediaType } from './exceptions'
import type { BaseContentNegotiation } from './negotiation'
import { type BaseParser, isHtmlInput, markHtmlInput, type ParserContext } from './parsers'
import type { BaseRenderer } from './renderers'
import { apiSettings } from './settings'

export interface APIRequestOptions {
  parsers?: BaseParser[]
  authenticators?: BaseAuthentication[]
  negotiator?: BaseContentNegotiation
  parserContext?: ParserContext
}

const FORM_MEDIA_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data']

/**
 * DRF's `Request`: wraps the Hono context with parsed data, authentication and content negotiation.
 *
 * - `request.data` — the parsed body (JSON, form or multipart incl. `File`s). It is parsed **before the handler
 *   runs** (in `APIView.initial()`), so it is a plain synchronous property; parse errors (`ParseError`,
 *   `UnsupportedMediaType`) are raised when it is first read, like DRF. Outside a view call
 *   `await request.loadData()` first.
 * - `request.query` (first value per key) / `request.queryParams` (`URLSearchParams`, DRF's `query_params`).
 * - `request.user`, `request.auth`, `request.successfulAuthenticator` — set by `APIView.initial()`.
 * - `request.c` — the Hono context; `request.raw` — the fetch `Request`.
 */
export class APIRequest {
  readonly c: Context
  parsers: BaseParser[]
  authenticators: BaseAuthentication[]
  negotiator?: BaseContentNegotiation
  parserContext: ParserContext
  acceptedRenderer?: BaseRenderer
  acceptedMediaType?: string
  version?: string | null

  _data: any = undefined
  _files: Record<string, File | File[]> = {}
  _dataError: unknown = undefined
  _loaded = false
  _user: RequestUser | undefined = undefined
  _auth: unknown = undefined
  _authenticator: BaseAuthentication | null = null
  _queryParams?: URLSearchParams
  /** @internal method override (OPTIONS metadata checks permissions as POST / PUT). */
  _method?: string

  constructor(c: Context, opts: APIRequestOptions = {}) {
    this.c = c
    this.parsers = opts.parsers ?? []
    this.authenticators = opts.authenticators ?? []
    this.negotiator = opts.negotiator
    this.parserContext = opts.parserContext ?? {}
    const forcedId = c.req.header(FORCE_AUTH_HEADER)
    if (forcedId && forcedAuthRegistry.has(forcedId)) {
      const [user, token] = forcedAuthRegistry.get(forcedId)!
      this.authenticators = [new ForcedAuthentication(user, token)]
    }
  }

  /** The fetch `Request`. */
  get raw(): Request {
    return this.c.req.raw
  }

  /** Upper-case HTTP method. */
  get method(): string {
    return this._method ?? this.c.req.method.toUpperCase()
  }

  get url(): string {
    return this.c.req.url
  }

  get path(): string {
    return this.c.req.path
  }

  get headers(): Headers {
    return this.c.req.raw.headers
  }

  header(name: string): string | undefined {
    return this.c.req.header(name)
  }

  /** `Content-Type` of the body (DRF's `request.content_type`). */
  get contentType(): string {
    return this.c.req.header('content-type') ?? ''
  }

  /** All query parameters (DRF's `request.query_params`). */
  get queryParams(): URLSearchParams {
    this._queryParams ??= new URL(this.c.req.url).searchParams
    return this._queryParams
  }

  /** Query parameters as a plain object (first value per key). */
  get query(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of this.queryParams) if (!(k in out)) out[k] = v
    return out
  }

  // ---------------------------------------------------------------- body

  /** Parsed request body. See the class docs. */
  get data(): any {
    if (!this._loaded) {
      throw new TypeError(
        'request.data has not been parsed yet. API views parse it before calling the handler; elsewhere call `await request.loadData()` first.',
      )
    }
    if (this._dataError !== undefined) {
      const err = this._dataError
      this._dataError = undefined
      throw err
    }
    return this._data
  }

  set data(value: any) {
    this._data = value
    this._loaded = true
  }

  /** Uploaded files (also included in `request.data`). */
  get files(): Record<string, File | File[]> {
    void this.data
    return this._files
  }

  /** True when the body is an HTML form (urlencoded / multipart). */
  get isFormInput(): boolean {
    return this._loaded && isHtmlInput(this._data)
  }

  /** Parse the body with the first matching parser. Errors are kept and raised when `data` is read. */
  async loadData(): Promise<void> {
    if (this._loaded) return
    try {
      const { data, files } = await this.parse()
      this._data = data
      this._files = files
    } catch (err) {
      this._data = {}
      this._files = {}
      if (err instanceof APIException) this._dataError = err
      else throw err
    }
    this._loaded = true
  }

  async parse(): Promise<{ data: any; files: Record<string, File | File[]> }> {
    const mediaType = this.contentType
    const hasBody =
      this.c.req.raw.body !== null &&
      !['GET', 'HEAD'].includes(this.method) &&
      this.c.req.header('content-length') !== '0'
    if (!hasBody || !mediaType) {
      const isForm = FORM_MEDIA_TYPES.some((t) => mediaType.startsWith(t))
      return { data: isForm ? markHtmlInput({}) : {}, files: {} }
    }
    const parser = this.negotiator?.selectParser(this, this.parsers) ?? null
    if (!parser) throw new UnsupportedMediaType(mediaType.split(';')[0].trim())
    return parser.parse(this.c, mediaType, { ...this.parserContext, request: this })
  }

  // ---------------------------------------------------------------- authentication

  /** The authenticated user (or `UNAUTHENTICATED_USER`, normally `AnonymousUser`). */
  get user(): RequestUser {
    if (this._user === undefined) {
      throw new TypeError(
        'request.user is not available before authentication; API views authenticate in initial().',
      )
    }
    return this._user
  }

  set user(value: RequestUser) {
    this._user = value
    setUser(this.c, value)
  }

  /** The token / credentials returned by the successful authenticator (or `UNAUTHENTICATED_TOKEN`). */
  get auth(): unknown {
    return this._auth
  }

  set auth(value: unknown) {
    this._auth = value
  }

  /** The authentication instance that authenticated the request, or null. */
  get successfulAuthenticator(): BaseAuthentication | null {
    return this._authenticator
  }

  /** Run the authenticators in order (DRF's `_authenticate`). */
  async authenticate(): Promise<void> {
    for (const authenticator of this.authenticators) {
      let result: [RequestUser, unknown] | null
      try {
        result = await authenticator.authenticate(this.c)
      } catch (err) {
        this.notAuthenticated()
        throw err
      }
      if (result) {
        this._authenticator = authenticator
        this.user = result[0]
        this._auth = result[1]
        return
      }
    }
    this.notAuthenticated()
  }

  notAuthenticated(): void {
    this._authenticator = null
    const unauthUser = apiSettings.UNAUTHENTICATED_USER
    const unauthToken = apiSettings.UNAUTHENTICATED_TOKEN
    this._user = unauthUser ? unauthUser() : (null as unknown as RequestUser)
    this._auth = unauthToken ? unauthToken() : null
  }

  // ---------------------------------------------------------------- urls

  /** Absolute URL for `location` (default: the current URL), honoring `SECURE_PROXY_SSL_HEADER`. */
  buildAbsoluteUri(location?: string): string {
    const current = new URL(this.c.req.url)
    let base = current
    try {
      base = new URL(
        `${isSecure(this.c) ? 'https' : 'http'}://${getHost(this.c)}${current.pathname}${current.search}`,
      )
    } catch {}
    return new URL(location ?? base.toString(), base).toString()
  }
}

export { APIRequest as Request }

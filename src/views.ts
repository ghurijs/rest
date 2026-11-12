import {
  CSRF_EXEMPT_MARKER,
  ImproperlyConfigured,
  kwargs as urlKwargs,
  XFRAME_OPTIONS_EXEMPT_MARKER,
} from '@ghuri/core'
import type { Context } from 'hono'
import type { AuthenticationClass, BaseAuthentication } from './authentication'
import {
  AuthenticationFailed,
  type ExceptionHandlerContext,
  type ExceptionHandlerFunction,
  MethodNotAllowed,
  NotAuthenticated,
  PermissionDenied,
  Throttled,
} from './exceptions'
import type { BaseContentNegotiation, ContentNegotiationClass } from './negotiation'
import type { BaseParser, ParserClass } from './parsers'
import type { BasePermission, PermissionClass } from './permissions'
import type { BaseRenderer, RendererClass, RendererContext } from './renderers'
import { APIRequest } from './request'
import { APIResponse, isAPIResponse } from './response'
import { apiSettings } from './settings'
import type { BaseThrottle, ThrottleClass } from './throttling'
import { camelToWords, stripSuffix } from './utils'

export type HttpMethodName = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace'

/** What handlers may return: an `APIResponse`, a fetch `Response`, or plain data (wrapped in `APIResponse`). */
export type HandlerResult = APIResponse | Response | unknown

/** View function produced by `asView()`; carries the class for routers / schema generation. */
export interface APIViewFunction {
  (c: Context): Promise<Response>
  /** The view class (core's `viewClass`, DRF's `cls`). */
  viewClass: any
  cls: any
  initkwargs: Record<string, unknown>
  viewInitkwargs: Record<string, unknown>
  /** ViewSets: HTTP method → action name. */
  actions?: Record<string, string>
}

export interface MetadataLike {
  determineMetadata(request: APIRequest, view: any): unknown
}

/**
 * DRF's `APIView`: content negotiation, parsing, authentication, permissions and throttling around your
 * handlers. Handlers are methods named after HTTP methods and receive the `APIRequest` and URL kwargs:
 *
 * ```ts
 * class ListUsers extends APIView {
 *   permissionClasses = [IsAdminUser]
 *   async get(request: APIRequest) {
 *     return new APIResponse(await User.objects.valuesList('username', { flat: true }))
 *   }
 * }
 * urlpatterns = [path('users/', ListUsers.asView())]
 * ```
 * Class attributes (`permissionClasses`, `renderer...`) are instance properties; unset ones use `REST_FRAMEWORK`
 * defaults. API views are CSRF-exempt; `MiddlewareAuthentication` / auth's `SessionAuthentication` enforce CSRF.
 */
export class APIView {
  static httpMethodNames: HttpMethodName[] = [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'head',
    'options',
    'trace',
  ]
  /** Static description (DRF uses the docstring): shown by the browsable API and OpenAPI. */
  static description?: string
  /** Exempt every view produced by `asView()` from `XFrameOptionsMiddleware` (core's `xframeOptionsExempt`). */
  static xframeOptionsExempt = false

  declare rendererClasses?: RendererClass[]
  declare parserClasses?: ParserClass[]
  declare authenticationClasses?: AuthenticationClass[]
  declare throttleClasses?: ThrottleClass[]
  declare permissionClasses?: PermissionClass[]
  declare contentNegotiationClass?: ContentNegotiationClass
  declare metadataClass?: (new () => MetadataLike) | null
  /** OpenAPI schema generator for this view (`new AutoSchema({ tags: ['posts'] })`), or null to exclude. */
  declare schema?: any
  /** Scope for `ScopedRateThrottle`. */
  declare throttleScope?: string
  /** Human-readable name / description (browsable API, OpenAPI). */
  declare name?: string
  declare description?: string
  declare _ignoreModelPermissions?: boolean

  get?(request: APIRequest, kwargs: Record<string, any>): HandlerResult | Promise<HandlerResult>
  post?(request: APIRequest, kwargs: Record<string, any>): HandlerResult | Promise<HandlerResult>
  put?(request: APIRequest, kwargs: Record<string, any>): HandlerResult | Promise<HandlerResult>
  patch?(request: APIRequest, kwargs: Record<string, any>): HandlerResult | Promise<HandlerResult>
  delete?(request: APIRequest, kwargs: Record<string, any>): HandlerResult | Promise<HandlerResult>
  head?(request: APIRequest, kwargs: Record<string, any>): HandlerResult | Promise<HandlerResult>
  trace?(request: APIRequest, kwargs: Record<string, any>): HandlerResult | Promise<HandlerResult>

  /** The Hono context. */
  c!: Context
  /** The REST request wrapper (DRF's `self.request`). */
  request!: APIRequest
  /** URL parameters (converted by their converters). */
  kwargs: Record<string, any> = {}
  args: unknown[] = []
  /** Headers added to every response (`Allow`, `Vary`). */
  headers: Record<string, string> = {}
  /** Format suffix / `?format=` value. */
  format?: string | null

  /** Build the view function (`path('x/', MyView.asView())`). `initkwargs` override instance attributes. */
  static asView(this: any, initkwargs: Record<string, unknown> = {}): APIViewFunction {
    for (const key of Object.keys(initkwargs)) {
      if ((this.httpMethodNames as string[]).includes(key)) {
        throw new ImproperlyConfigured(
          `The method name ${key} is not accepted as a keyword argument to ${this.name}.asView().`,
        )
      }
    }
    const view = (async (c: Context) => {
      const self = new this()
      Object.assign(self, initkwargs)
      return self.dispatch(c)
    }) as APIViewFunction
    view.viewClass = this
    view.cls = this
    view.initkwargs = initkwargs
    view.viewInitkwargs = initkwargs
    Object.defineProperty(view, 'name', { value: this.name })
    ;(view as any)[CSRF_EXEMPT_MARKER] = true
    if (this.xframeOptionsExempt) (view as any)[XFRAME_OPTIONS_EXEMPT_MARKER] = true
    return view
  }

  /** Upper-case HTTP methods this view handles (`Allow` header). */
  allowedMethods(): string[] {
    const names = (this.constructor as typeof APIView).httpMethodNames as string[]
    const out = names.filter((m) => typeof (this as any)[m] === 'function').map((m) => m.toUpperCase())
    if (out.includes('GET') && !out.includes('HEAD')) out.splice(out.indexOf('GET') + 1, 0, 'HEAD')
    return out
  }

  defaultResponseHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Allow: this.allowedMethods().join(', ') }
    if (this.getRenderers().length > 1) headers.Vary = 'Accept'
    return headers
  }

  /** Name shown in the browsable API (`PostList` → `Post List`). */
  getViewName(): string {
    if (this.name) return this.name
    let name = this.constructor.name
    name = stripSuffix(name, 'View')
    name = stripSuffix(name, 'ViewSet')
    name = camelToWords(name)
    const suffix = (this as any).suffix
    return suffix ? `${name} ${suffix}` : name
  }

  getViewDescription(): string {
    return this.description ?? (this.constructor as typeof APIView).description ?? ''
  }

  // ---------------------------------------------------------------- policy instantiation

  getRenderers(): BaseRenderer[] {
    return (this.rendererClasses ?? apiSettings.DEFAULT_RENDERER_CLASSES).map((R) => new R())
  }

  getParsers(): BaseParser[] {
    return (this.parserClasses ?? apiSettings.DEFAULT_PARSER_CLASSES).map((P) => new P())
  }

  getAuthenticators(): BaseAuthentication[] {
    return (this.authenticationClasses ?? apiSettings.DEFAULT_AUTHENTICATION_CLASSES).map((A) => new A())
  }

  getPermissions(): BasePermission[] {
    return (this.permissionClasses ?? apiSettings.DEFAULT_PERMISSION_CLASSES).map((P) => new P())
  }

  getThrottles(): BaseThrottle[] {
    return (this.throttleClasses ?? apiSettings.DEFAULT_THROTTLE_CLASSES).map((T) => new T())
  }

  getContentNegotiator(): BaseContentNegotiation {
    const C = this.contentNegotiationClass ?? apiSettings.DEFAULT_CONTENT_NEGOTIATION_CLASS
    return new C()
  }

  getExceptionHandler(): ExceptionHandlerFunction {
    return apiSettings.EXCEPTION_HANDLER
  }

  getParserContext(_c: Context): Record<string, unknown> {
    return { view: this, args: this.args, kwargs: this.kwargs }
  }

  getRendererContext(): RendererContext {
    return { view: this, args: this.args, kwargs: this.kwargs, request: this.request }
  }

  getExceptionHandlerContext(): ExceptionHandlerContext {
    return { view: this, args: this.args, kwargs: this.kwargs, request: this.request }
  }

  /** `format` URL kwarg (from `.json`-style suffix routes). */
  getFormatSuffix(kwargs: Record<string, any>): string | null {
    const key = apiSettings.FORMAT_SUFFIX_KWARG
    return key ? (kwargs[key] ?? null) : null
  }

  // ---------------------------------------------------------------- request lifecycle

  initializeRequest(c: Context): APIRequest {
    return new APIRequest(c, {
      parsers: this.getParsers(),
      authenticators: this.getAuthenticators(),
      negotiator: this.getContentNegotiator(),
      parserContext: this.getParserContext(c),
    })
  }

  performContentNegotiation(request: APIRequest, force = false): [BaseRenderer, string] {
    const renderers = this.getRenderers()
    const conneg = this.getContentNegotiator()
    try {
      return conneg.selectRenderer(request, renderers, this.format)
    } catch (err) {
      if (!force) throw err
      return [renderers[0], renderers[0].mediaType]
    }
  }

  async performAuthentication(request: APIRequest): Promise<void> {
    await request.authenticate()
  }

  /** Raise if any permission denies the request. */
  async checkPermissions(request: APIRequest): Promise<void> {
    for (const permission of this.getPermissions()) {
      if (!(await permission.hasPermission(request, this))) {
        this.permissionDenied(request, permission.message, permission.code)
      }
    }
  }

  /** Raise if any permission denies access to `obj` (called by `getObject()`). */
  async checkObjectPermissions(request: APIRequest, obj: unknown): Promise<void> {
    for (const permission of this.getPermissions()) {
      if (!(await permission.hasObjectPermission(request, this, obj))) {
        this.permissionDenied(request, permission.message, permission.code)
      }
    }
  }

  async checkThrottles(request: APIRequest): Promise<void> {
    const durations: Array<number | null> = []
    for (const throttle of this.getThrottles()) {
      if (!(await throttle.allowRequest(request, this))) durations.push(throttle.wait())
    }
    if (durations.length) {
      const known = durations.filter((d): d is number => d !== null)
      this.throttled(request, known.length ? Math.max(...known) : null)
    }
  }

  permissionDenied(request: APIRequest, message?: unknown, code?: string): never {
    if (request.authenticators.length && !request.successfulAuthenticator) throw new NotAuthenticated()
    throw new PermissionDenied((message as any) ?? null, code ?? null)
  }

  throttled(_request: APIRequest, wait: number | null): never {
    throw new Throttled(wait)
  }

  /** `WWW-Authenticate` value for 401 responses (from the first authentication class). */
  getAuthenticateHeader(request: APIRequest): string | undefined {
    const authenticators = this.getAuthenticators()
    if (authenticators.length) return authenticators[0].authenticateHeader?.(request.c)
    return undefined
  }

  /** Runs before the handler: parse body, negotiate, authenticate, check permissions and throttles. */
  async initial(request: APIRequest): Promise<void> {
    this.format = this.getFormatSuffix(this.kwargs)
    await request.loadData()
    const [renderer, mediaType] = this.performContentNegotiation(request)
    request.acceptedRenderer = renderer
    request.acceptedMediaType = mediaType
    request.version = null
    await this.performAuthentication(request)
    await this.checkPermissions(request)
    await this.checkThrottles(request)
  }

  /** Map an exception to a response via `EXCEPTION_HANDLER`; unknown errors are re-thrown (→ 500). */
  async handleException(exc: unknown): Promise<APIResponse> {
    if (exc instanceof NotAuthenticated || exc instanceof AuthenticationFailed) {
      const header = this.request ? this.getAuthenticateHeader(this.request) : undefined
      if (header) exc.authHeader = header
      else exc.statusCode = 403
    }
    const handler = this.getExceptionHandler()
    const response = await handler(exc, this.getExceptionHandlerContext())
    if (!response) this.raiseUncaughtException(exc)
    response.exception = true
    return response
  }

  raiseUncaughtException(exc: unknown): never {
    throw exc
  }

  /** Render the handler's result into a fetch `Response`. */
  async finalizeResponse(request: APIRequest, response: HandlerResult): Promise<Response> {
    if (response === undefined) {
      throw new TypeError(
        `Expected an \`APIResponse\`, \`Response\` or data to be returned from the view, but received \`undefined\` (${this.constructor.name}.${request.method.toLowerCase()}).`,
      )
    }
    if (response instanceof Response) {
      for (const [k, v] of Object.entries(this.headers))
        if (!response.headers.has(k)) {
          try {
            response.headers.set(k, v)
          } catch {
            // immutable headers (e.g. a fetched Response)
          }
        }
      return response
    }
    const res = isAPIResponse(response) ? response : new APIResponse(response)
    if (!request.acceptedRenderer) {
      const [renderer, mediaType] = this.performContentNegotiation(request, true)
      request.acceptedRenderer = renderer
      request.acceptedMediaType = mediaType
    }
    res.acceptedRenderer = request.acceptedRenderer
    res.acceptedMediaType = request.acceptedMediaType
    res.rendererContext = this.getRendererContext()
    const vary = res.headers.get('vary')
    for (const [k, v] of Object.entries(this.headers)) {
      if (k.toLowerCase() === 'vary' && vary) {
        const parts = new Set([...vary.split(/\s*,\s*/), ...v.split(/\s*,\s*/)])
        res.headers.set('Vary', [...parts].join(', '))
      } else if (!res.headers.has(k)) res.headers.set(k, v)
    }
    return res.render(request.method)
  }

  /** Request entry point: initialize, run `initial()`, call the handler, handle errors, render. */
  async dispatch(c: Context): Promise<Response> {
    this.c = c
    this.kwargs = { ...urlKwargs(c), ...this.kwargs }
    const request = this.initializeRequest(c)
    this.request = request
    this.headers = this.defaultResponseHeaders()
    let response: HandlerResult
    try {
      await this.initial(request)
      const method = request.method.toLowerCase()
      const names = (this.constructor as typeof APIView).httpMethodNames as string[]
      let handler: ((request: APIRequest, kwargs: Record<string, any>) => unknown) | undefined
      if (names.includes(method)) handler = (this as any)[method]
      if (typeof handler !== 'function' && method === 'head') handler = (this as any).get
      if (typeof handler !== 'function') handler = this.httpMethodNotAllowed
      response = await handler.call(this, request, this.kwargs)
    } catch (exc) {
      response = await this.handleException(exc)
    }
    return this.finalizeResponse(request, response)
  }

  httpMethodNotAllowed(request: APIRequest): never {
    throw new MethodNotAllowed(request.method)
  }

  /** OPTIONS: describe the view with `metadataClass` (DRF's SimpleMetadata). */
  async options(request: APIRequest): Promise<APIResponse> {
    if (this.metadataClass === null) this.httpMethodNotAllowed(request)
    const M = this.metadataClass ?? apiSettings.DEFAULT_METADATA_CLASS
    const data = await new M().determineMetadata(request, this)
    return new APIResponse(data, { status: 200 })
  }
}

export interface APIViewOptions {
  rendererClasses?: RendererClass[]
  parserClasses?: ParserClass[]
  authenticationClasses?: AuthenticationClass[]
  throttleClasses?: ThrottleClass[]
  permissionClasses?: PermissionClass[]
  contentNegotiationClass?: ContentNegotiationClass
  schema?: any
  throttleScope?: string
  name?: string
  description?: string
}

export type FunctionViewHandler = (
  this: APIView,
  request: APIRequest,
  kwargs: Record<string, any>,
  view: APIView,
) => HandlerResult | Promise<HandlerResult>

/**
 * Function-based API view (DRF's `@api_view`):
 *
 * ```ts
 * export const hello = apiView(['GET', 'POST'], { permissionClasses: [AllowAny] })(async (request) => {
 *   if (request.method === 'POST') return new APIResponse({ message: 'Got some data!', data: request.data })
 *   return { message: 'Hello, world!' }
 * })
 * ```
 */
export function apiView(
  methods: string[] = ['GET'],
  opts: APIViewOptions = {},
): (fn: FunctionViewHandler) => APIViewFunction {
  const allowed = methods.map((m) => m.toLowerCase())
  return (fn) => {
    const Wrapped = class WrappedAPIView extends APIView {}
    Object.defineProperty(Wrapped, 'name', {
      value: fn.name ? fn.name[0].toUpperCase() + fn.name.slice(1) : 'WrappedAPIView',
    })
    const handler = function (this: APIView, request: APIRequest, kwargs: Record<string, any>) {
      return fn.call(this, request, kwargs, this)
    }
    for (const m of allowed) (Wrapped.prototype as any)[m] = handler
    Wrapped.httpMethodNames = [...new Set([...allowed, 'options'])] as HttpMethodName[]
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'description') Wrapped.description = v as string
      else (Wrapped.prototype as any)[k] = v
    }
    const view = Wrapped.asView()
    ;(view as any).func = fn
    return view
  }
}

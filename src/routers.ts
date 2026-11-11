import type { RequestUser } from '@ghuri/core'
import {
  converters,
  ImproperlyConfigured,
  NoReverseMatch,
  path,
  registerConverter,
  rePath,
  resolverMatch,
  reverse,
  type UrlEntry,
  type UrlPatterns,
} from '@ghuri/core'
import { Hono } from 'hono'
import { ForcedAuthentication } from './authentication'
import { type ActionInfo, getExtraActions } from './decorators'
import type { JSONSchema, JSONSchemaOptions } from './fields'
import type { APIRequest } from './request'
import { APIResponse } from './response'
import { APIView } from './views'

export interface Route {
  /** Template with `{prefix}`, `{lookup}`, `{trailingSlash}` (and `{urlPath}` for dynamic routes). */
  url: string
  /** HTTP method → action. */
  mapping: Record<string, string>
  /** Template with `{basename}` (and `{urlName}`). */
  name: string
  detail: boolean
  initkwargs: Record<string, unknown>
}

export interface DynamicRoute {
  dynamic: true
  url: string
  name: string
  detail: boolean
  initkwargs: Record<string, unknown>
}

/** One generated URL of a registered viewset (introspection). */
export interface RouteInfo {
  /** URL name (`post-list`, `post-detail`, `post-publish`). */
  name: string
  /** Route relative to where the router is included (`posts/<restlookup:pk>/`). */
  pattern: string
  detail: boolean
  /** Upper-case HTTP method → action. */
  methods: Record<string, string>
  /** Extra action info for `@action` routes. */
  action?: ActionInfo
}

/** One endpoint (HTTP method + action) of a registered viewset, for agents / tooling. */
export interface EndpointInfo {
  action: string
  method: string
  detail: boolean
  name: string
  pattern: string
  extra: boolean
  description?: string
}

// `[^/.]+` like DRF's default lookup_value_regex (dots are reserved for format suffixes).
registerConverter('restlookup', { regex: '[^/.]+', toJs: (v: string) => v, toUrl: (v: unknown) => String(v) })
const customConverters = new Map<string, string>()

function converterForRegex(regex: string): string {
  let name = customConverters.get(regex)
  if (!name) {
    name = `restlookup${customConverters.size + 1}`
    registerConverter(name, { regex, toJs: (v: string) => v, toUrl: (v: unknown) => String(v) })
    customConverters.set(regex, name)
  }
  return name
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `posts/<restlookup:pk>/` → `posts/(?<pk>[^/.]+)/` */
function routeToRegex(route: string): string {
  let out = ''
  let last = 0
  for (const m of route.matchAll(/<(?:([^<>:]+):)?([^<>]+)>/g)) {
    out += escapeRegex(route.slice(last, m.index))
    const conv = converters[m[1] ?? 'str']
    out += `(?<${m[2]}>${conv?.regex ?? '[^/]+'})`
    last = m.index! + m[0].length
  }
  return out + escapeRegex(route.slice(last))
}

const attrCache = new WeakMap<object, any>()

/** A throwaway instance of a viewset (to read instance-property configuration). */
function prototypeInstance(viewset: any): any {
  let inst = attrCache.get(viewset)
  if (inst === undefined) {
    try {
      inst = new viewset()
    } catch {
      inst = null
    }
    attrCache.set(viewset, inst)
  }
  return inst
}

function viewsetAttr(viewset: any, name: string): any {
  const inst = prototypeInstance(viewset)
  const v = inst?.[name]
  return v !== undefined ? v : viewset[name]
}

/** Registry entry (DRF's `(prefix, viewset, basename)` tuple) with introspection helpers. */
export class RouterRegistration {
  constructor(
    readonly router: SimpleRouter,
    readonly prefix: string,
    readonly viewset: any,
    readonly basename: string,
  ) {}

  /** Extra actions declared with `@action` / `static actions`. */
  get extraActions(): ActionInfo[] {
    return getExtraActions(this.viewset)
  }

  /** Generated routes. */
  get routes(): RouteInfo[] {
    return this.router.getRouteInfo(this)
  }

  /** Every (HTTP method, action) pair, e.g. `{ action: 'list', method: 'GET', name: 'post-list', … }`. */
  get endpoints(): EndpointInfo[] {
    const out: EndpointInfo[] = []
    for (const r of this.routes) {
      for (const [method, action] of Object.entries(r.methods)) {
        out.push({
          action,
          method,
          detail: r.detail,
          name: r.name,
          pattern: r.pattern,
          extra: !!r.action,
          description: (r.action?.kwargs.description as string | undefined) ?? undefined,
        })
      }
    }
    return out
  }

  /** Action names this viewset exposes (`['list', 'create', 'retrieve', …, 'publish']`). */
  get actions(): string[] {
    return [...new Set(this.endpoints.map((e) => e.action))]
  }

  /** The model behind `queryset`, if any. */
  get model(): any {
    const qs = viewsetAttr(this.viewset, 'queryset')
    return qs?.model ?? (typeof qs === 'function' && qs._meta ? qs : undefined)
  }

  /** A configured viewset instance for `action` (no request), as the router would build it. */
  viewFor(action?: string): any {
    const view = new this.viewset()
    const endpoint = action ? this.endpoints.find((e) => e.action === action) : undefined
    const extra = action ? this.extraActions.find((a) => a.name === action) : undefined
    Object.assign(view, extra?.kwargs ?? {}, { basename: this.basename, detail: endpoint?.detail ?? false })
    view.action = action
    view.actionMap = endpoint ? { [endpoint.method.toLowerCase()]: action } : {}
    view.kwargs = {}
    return view
  }

  /** Serializer class used for `action` (honors `getSerializerClass()` overrides that switch on `this.action`). */
  getSerializerClass(action?: string): any {
    const view = this.viewFor(action)
    if (typeof view.getSerializerClass !== 'function') return undefined
    try {
      return view.getSerializerClass()
    } catch {
      return undefined
    }
  }

  /** JSON Schema of the serializer for `action` (`mode: 'input'` for request bodies). */
  jsonSchema(action?: string, opts: JSONSchemaOptions = {}): JSONSchema | undefined {
    const cls = this.getSerializerClass(action)
    if (!cls) return undefined
    const view = this.viewFor(action)
    const serializer = new cls({ context: { view, request: undefined } })
    return serializer.jsonSchema(opts)
  }

  /**
   * Run an action without HTTP routing (for agents, queues, scripts): the full view pipeline runs —
   * permissions, throttles, validation, serialization — with `user` as the authenticated user.
   *
   * ```ts
   * const { status, data } = await router.registry[0].invoke('create', { user, data: { title: 'Hi' } })
   * const { data: post } = await entry.invoke('retrieve', { user, kwargs: { pk: 1 } })
   * ```
   */
  async invoke(action: string, opts: InvokeOptions = {}): Promise<InvokeResult> {
    const endpoint = this.endpoints.find(
      (e) => e.action === action && (!opts.method || e.method === opts.method.toUpperCase()),
    )
    if (!endpoint)
      throw new ImproperlyConfigured(`${this.viewset.name} has no action '${action}' routed by the router.`)
    const method = endpoint.method
    const route = this.routes.find((r) => r.name === endpoint.name)
    const user = opts.user ?? null
    const Forced = class InvokeAuthentication extends ForcedAuthentication {
      constructor() {
        super(user, opts.auth ?? null)
      }
    }
    const initkwargs: Record<string, unknown> = {
      ...(route?.action?.kwargs ?? {}),
      ...(endpoint.detail ? { suffix: 'Instance' } : { suffix: 'List' }),
      basename: this.basename,
      detail: endpoint.detail,
      kwargs: { ...(opts.kwargs ?? {}) },
      authenticationClasses: [Forced],
    }
    if (route?.action) delete initkwargs.suffix
    const view = this.viewset.asView({ [method.toLowerCase()]: action }, initkwargs)
    const url = new URL(
      `http://localhost/${endpoint.pattern.replace(/<[^>]+>/g, (m) => String(opts.kwargs?.[m.slice(1, -1).split(':').pop()!] ?? '_'))}`,
    )
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      for (const x of Array.isArray(v) ? v : [v])
        if (x !== undefined && x !== null) url.searchParams.append(k, String(x))
    }
    const headers = new Headers({ accept: 'application/json', ...(opts.headers ?? {}) })
    let body: string | undefined
    if (opts.data !== undefined && !['GET', 'HEAD'].includes(method)) {
      body = JSON.stringify(opts.data)
      headers.set('content-type', 'application/json')
    }
    const hono = new Hono()
    hono.all('*', (c) => view(c))
    const res = await hono.fetch(new Request(url, { method, headers, body }))
    const text = await res.text()
    let data: unknown = text
    if ((res.headers.get('content-type') ?? '').includes('json')) data = text ? JSON.parse(text) : null
    else if (!text) data = null
    return { status: res.status, data, headers: res.headers }
  }

  toJSON(): Record<string, unknown> {
    return {
      prefix: this.prefix,
      basename: this.basename,
      viewset: this.viewset.name,
      model: this.model?._meta?.label,
      actions: this.actions,
      routes: this.routes.map(({ action: _a, ...r }) => r),
    }
  }
}

export interface InvokeOptions {
  /** The acting user (authentication classes are bypassed); anonymous when omitted. */
  user?: RequestUser | null
  /** `request.auth` value. */
  auth?: unknown
  /** Request body (sent as JSON). */
  data?: unknown
  /** Query parameters (filters, pagination). */
  query?: Record<string, unknown>
  /** URL kwargs, e.g. `{ pk: 1 }` for detail actions. */
  kwargs?: Record<string, unknown>
  /** HTTP method when an action accepts several. */
  method?: string
  headers?: Record<string, string>
}

export interface InvokeResult {
  status: number
  /** Parsed JSON body (null for empty bodies). */
  data: unknown
  headers: Headers
}

export interface SimpleRouterOptions {
  /** Append `/` to URLs (default true). */
  trailingSlash?: boolean
}

/** Base router: `register()` viewsets, then include `router.urls`. */
export abstract class BaseRouter {
  readonly registry: RouterRegistration[] = []
  _urls?: UrlPatterns

  /** DRF's `router.register(prefix, viewset, basename=None)`. */
  register(prefix: string, viewset: any, opts: { basename?: string } | string = {}): RouterRegistration {
    const basename = (typeof opts === 'string' ? opts : opts.basename) ?? this.getDefaultBasename(viewset)
    if (this.registry.some((r) => r.basename === basename)) {
      throw new ImproperlyConfigured(
        `Router with basename "${basename}" is already registered. Please provide a unique basename for viewset "${viewset.name}"`,
      )
    }
    const entry = new RouterRegistration(
      this as unknown as SimpleRouter,
      prefix.replace(/^\/+|\/+$/g, ''),
      viewset,
      basename,
    )
    this.registry.push(entry)
    this._urls = undefined
    return entry
  }

  /** True if `basename` is registered. */
  isAlreadyRegistered(basename: string): boolean {
    return this.registry.some((r) => r.basename === basename)
  }

  abstract getDefaultBasename(viewset: any): string
  abstract getUrls(): UrlPatterns

  /** URL patterns to `include()`. */
  get urls(): UrlPatterns {
    this._urls ??= this.getUrls()
    return this._urls
  }
}

/**
 * DRF's `SimpleRouter`: `prefix/` (list, create), `prefix/<lookup>/` (retrieve, update, partialUpdate,
 * destroy) and `@action` routes, named `<basename>-list`, `<basename>-detail`, `<basename>-<urlName>`.
 */
export class SimpleRouter extends BaseRouter {
  routes: Array<Route | DynamicRoute> = [
    {
      url: '{prefix}{trailingSlash}',
      mapping: { get: 'list', post: 'create' },
      name: '{basename}-list',
      detail: false,
      initkwargs: { suffix: 'List' },
    },
    {
      dynamic: true,
      url: '{prefix}/{urlPath}{trailingSlash}',
      name: '{basename}-{urlName}',
      detail: false,
      initkwargs: {},
    },
    {
      url: '{prefix}/{lookup}{trailingSlash}',
      mapping: { get: 'retrieve', put: 'update', patch: 'partialUpdate', delete: 'destroy' },
      name: '{basename}-detail',
      detail: true,
      initkwargs: { suffix: 'Instance' },
    },
    {
      dynamic: true,
      url: '{prefix}/{lookup}/{urlPath}{trailingSlash}',
      name: '{basename}-{urlName}',
      detail: true,
      initkwargs: {},
    },
  ]
  trailingSlash: string

  constructor(opts: SimpleRouterOptions = {}) {
    super()
    this.trailingSlash = opts.trailingSlash === false ? '' : '/'
  }

  getDefaultBasename(viewset: any): string {
    const qs = viewsetAttr(viewset, 'queryset')
    const model = qs?.model ?? (typeof qs === 'function' && qs._meta ? qs : undefined)
    if (!model) {
      throw new ImproperlyConfigured(
        '`basename` argument not specified, and could not automatically determine the name from the viewset, as it does not have a `queryset` attribute.',
      )
    }
    return model._meta.objectName.toLowerCase()
  }

  /** Routes for a viewset, with dynamic routes expanded for its extra actions. */
  getRoutes(viewset: any): Array<Route & { action?: ActionInfo }> {
    const known = new Set<string>()
    for (const r of this.routes) if (!('dynamic' in r)) for (const a of Object.values(r.mapping)) known.add(a)
    const extra = getExtraActions(viewset)
    const clash = extra.filter((a) => known.has(a.name)).map((a) => a.name)
    if (clash.length) {
      throw new ImproperlyConfigured(
        `Cannot use the @action decorator on the following methods, as they are existing routes: ${clash.join(', ')}`,
      )
    }
    const out: Array<Route & { action?: ActionInfo }> = []
    for (const route of this.routes) {
      if ('dynamic' in route) {
        for (const a of extra.filter((x) => x.detail === route.detail))
          out.push(this.getDynamicRoute(route, a))
      } else out.push(route)
    }
    return out
  }

  getDynamicRoute(route: DynamicRoute, action: ActionInfo): Route & { action: ActionInfo } {
    return {
      url: route.url.replace('{urlPath}', action.urlPath),
      mapping: action.mapping,
      name: route.name.replace('{urlName}', action.urlName),
      detail: route.detail,
      initkwargs: { ...route.initkwargs, ...action.kwargs },
      action,
    }
  }

  /** Keep only methods whose action exists on the viewset. */
  getMethodMap(viewset: any, methodMap: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [method, action] of Object.entries(methodMap)) {
      if (typeof viewset.prototype?.[action] === 'function') out[method] = action
    }
    return out
  }

  /** `<restlookup:pk>`-style path segment for the viewset's lookup. */
  getLookupPath(viewset: any): string {
    const field = viewsetAttr(viewset, 'lookupField') ?? 'pk'
    const kwarg = viewsetAttr(viewset, 'lookupUrlKwarg') ?? field
    const regex = viewsetAttr(viewset, 'lookupValueRegex')
    const conv = viewsetAttr(viewset, 'lookupValueConverter')
    if (conv) {
      if (!converters[conv])
        throw new ImproperlyConfigured(`Unknown path converter '${conv}' (lookupValueConverter).`)
      return `<${conv}:${kwarg}>`
    }
    if (regex) return `<${converterForRegex(regex)}:${kwarg}>`
    return `<restlookup:${kwarg}>`
  }

  buildUrl(entry: RouterRegistration, route: Route): string {
    let url = route.url
      .replace('{prefix}', entry.prefix)
      .replace('{lookup}', this.getLookupPath(entry.viewset))
      .replace('{trailingSlash}', this.trailingSlash)
    if (!entry.prefix) url = url.replace(/^\//, '')
    return url
  }

  getRouteInfo(entry: RouterRegistration): RouteInfo[] {
    const out: RouteInfo[] = []
    for (const route of this.getRoutes(entry.viewset)) {
      const mapping = this.getMethodMap(entry.viewset, route.mapping)
      if (!Object.keys(mapping).length) continue
      out.push({
        name: route.name.replace('{basename}', entry.basename),
        pattern: this.buildUrl(entry, route),
        detail: route.detail,
        methods: Object.fromEntries(Object.entries(mapping).map(([m, a]) => [m.toUpperCase(), a])),
        action: route.action,
      })
    }
    return out
  }

  /** URL entries for one route (subclasses add format-suffix variants). */
  makeEntries(url: string, view: any, name: string): UrlEntry[] {
    return [path(url, view, { name })]
  }

  getUrls(): UrlPatterns {
    const out: UrlPatterns = []
    for (const entry of this.registry) {
      for (const route of this.getRoutes(entry.viewset)) {
        const mapping = this.getMethodMap(entry.viewset, route.mapping)
        if (!Object.keys(mapping).length) continue
        const url = this.buildUrl(entry, route)
        const initkwargs = { ...route.initkwargs, basename: entry.basename, detail: route.detail }
        const view = entry.viewset.asView(mapping, initkwargs)
        out.push(...this.makeEntries(url, view, route.name.replace('{basename}', entry.basename)))
      }
    }
    return out
  }

  /** Introspection: every registration as plain JSON. */
  describe(): Array<Record<string, unknown>> {
    return this.registry.map((r) => r.toJSON())
  }
}

/** The API root (`DefaultRouter`): links to every registered list endpoint. */
export class APIRootView extends APIView {
  override _ignoreModelPermissions = true
  override schema = null
  apiRootDict: Record<string, string> = {}

  async get(request: APIRequest): Promise<APIResponse> {
    const ret: Record<string, string> = {}
    const ns = resolverMatch(request.c)?.namespace
    for (const [key, urlName] of Object.entries(this.apiRootDict)) {
      const name = ns ? `${ns}:${urlName}` : urlName
      try {
        ret[key] = request.buildAbsoluteUri(reverse(name))
      } catch (err) {
        if (!(err instanceof NoReverseMatch)) throw err
      }
    }
    return new APIResponse(ret)
  }
}

export interface DefaultRouterOptions extends SimpleRouterOptions {
  /** Serve the API root at `''` (default true). */
  includeRootView?: boolean
  /** Also route `posts.json` / `posts/1.json` (default true). */
  includeFormatSuffixes?: boolean
  rootViewName?: string
}

/** `SimpleRouter` + an API root view (`api-root`) + optional `.json` format suffixes (DRF's `DefaultRouter`). */
export class DefaultRouter extends SimpleRouter {
  includeRootView: boolean
  includeFormatSuffixes: boolean
  rootViewName: string
  APIRootView: typeof APIRootView = APIRootView

  constructor(opts: DefaultRouterOptions = {}) {
    super(opts)
    this.includeRootView = opts.includeRootView ?? true
    this.includeFormatSuffixes = opts.includeFormatSuffixes ?? true
    this.rootViewName = opts.rootViewName ?? 'api-root'
  }

  getApiRootView(): any {
    const apiRootDict: Record<string, string> = {}
    const listName = this.routes[0].name
    for (const r of this.registry) apiRootDict[r.prefix] = listName.replace('{basename}', r.basename)
    return this.APIRootView.asView({ apiRootDict })
  }

  override makeEntries(url: string, view: any, name: string): UrlEntry[] {
    const entries = super.makeEntries(url, view, name)
    if (this.includeFormatSuffixes) {
      const base = url.replace(/\/$/, '')
      if (base) entries.push(rePath(`^${routeToRegex(base)}\\.(?<format>[a-z0-9]+)/?$`, view, { name }))
    }
    return entries
  }

  override getUrls(): UrlPatterns {
    const urls = super.getUrls()
    if (this.includeRootView) {
      const root = path('', this.getApiRootView(), { name: this.rootViewName })
      const out = [root, ...urls] as UrlPatterns
      if (this.includeFormatSuffixes)
        out.splice(1, 0, rePath('^\\.(?<format>[a-z0-9]+)/?$', root.view!, { name: this.rootViewName }))
      return out
    }
    return urls
  }
}

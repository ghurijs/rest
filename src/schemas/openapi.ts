import { include, path, type UrlPatterns, UrlResolver } from '@ghuri/core'
import { SCHEMA_EXTENSION, type SchemaExtension } from '../decorators'
import type { JSONSchema, JSONSchemaOptions } from '../fields'
import { AllowAny } from '../permissions'
import { BaseSerializer, Serializer } from '../serializers'
import { apiSettings } from '../settings'
import { capfirst, isModelClass, stripSuffix } from '../utils'
import { APIView } from '../views'

export interface SchemaInfo {
  title?: string
  version?: string
  description?: string
  [key: string]: unknown
}

export interface GenerateSchemaOptions extends SchemaInfo {
  /** OpenAPI `info` (merged with `title` / `version` / `description`). */
  info?: SchemaInfo
  servers?: Array<{ url: string; description?: string }>
  /** Mount path when the source is a router or patterns included under a prefix (`'api/'`). */
  prefix?: string
  /** Strip this leading path when computing default tags (default: the common prefix of all paths). */
  tagPrefix?: string
}

export type OpenAPIDocument = Record<string, any>

/** An endpoint found in the URL patterns. */
export interface Endpoint {
  path: string
  method: string
  view: any
  cls: any
  initkwargs: Record<string, unknown>
  actions?: Record<string, string>
}

const METHOD_MAPPING: Record<string, string> = {
  get: 'retrieve',
  post: 'create',
  put: 'update',
  patch: 'partialUpdate',
  delete: 'destroy',
}

function isAPIViewClass(cls: unknown): boolean {
  return typeof cls === 'function' && (cls === APIView || (cls as any).prototype instanceof APIView)
}

/** Route pattern → OpenAPI path (`posts/<restlookup:pk>/` → `/posts/{pk}/`). */
function toOpenAPIPath(route: any): string | null {
  if (route.tokens) {
    const s = route.tokens.map((t: any) => ('lit' in t ? t.lit : `{${t.param}}`)).join('')
    return `/${s}`
  }
  const src: string = route.pattern
  if (src.includes('(?<format>')) return null
  let out = ''
  let i = 0
  while (i < src.length) {
    const m = /^\(\?<([A-Za-z_]\w*)>/.exec(src.slice(i))
    if (m) {
      let depth = 0
      let j = i
      for (; j < src.length; j++) {
        if (src[j] === '\\') {
          j++
          continue
        }
        if (src[j] === '(') depth++
        else if (src[j] === ')') {
          depth--
          if (depth === 0) break
        }
      }
      out += `{${m[1]}}`
      i = j + 1
      continue
    }
    const ch = src[i]
    if (ch === '\\') {
      out += src[i + 1] ?? ''
      i += 2
      continue
    }
    if ('^$?*+'.includes(ch)) {
      i++
      continue
    }
    out += ch
    i++
  }
  return `/${out.replace(/^\//, '')}`
}

/** Enumerate API view endpoints of a urlconf (DRF's `EndpointEnumerator`). */
export function getEndpoints(patterns: UrlPatterns): Endpoint[] {
  const resolver = new UrlResolver(patterns)
  const out: Endpoint[] = []
  for (const route of resolver.routes) {
    if (route.kind !== 'view' || !route.view) continue
    const view: any = route.view
    const cls = view.cls ?? view.viewClass
    if (!isAPIViewClass(cls)) continue
    const p = toOpenAPIPath(route)
    if (!p || p.includes('{format}')) continue
    const initkwargs = view.initkwargs ?? view.viewInitkwargs ?? {}
    let methods: string[]
    if (view.actions) methods = Object.keys(view.actions)
    else {
      try {
        const inst = new cls()
        Object.assign(inst, initkwargs)
        methods = inst.allowedMethods().map((m: string) => m.toLowerCase())
      } catch {
        methods = ['get']
      }
    }
    for (const m of methods) {
      if (m === 'head' || m === 'options' || m === 'trace') continue
      out.push({ path: p, method: m.toUpperCase(), view, cls, initkwargs, actions: view.actions })
    }
  }
  return out
}

/** Build a view instance configured as for a request to `endpoint` (no request attached). */
export function viewForEndpoint(endpoint: Endpoint): any {
  const view = new endpoint.cls()
  Object.assign(view, endpoint.initkwargs)
  const method = endpoint.method.toLowerCase()
  if (endpoint.actions) {
    view.actionMap = endpoint.actions
    view.action = endpoint.actions[method]
  }
  view.kwargs = {}
  view.schemaPath = endpoint.path
  view.schemaMethod = endpoint.method
  return view
}

/** Builds the OpenAPI 3.1 document: paths from views, components from serializers (DRF's `SchemaGenerator`). */
export class SchemaGenerator {
  readonly schemas: Record<string, JSONSchema> = {}
  readonly securitySchemes: Record<string, unknown> = {}
  readonly componentOwners = new Map<string, any>()
  readonly operationIds = new Set<string>()
  tagPrefix = ''

  constructor(
    readonly patterns: UrlPatterns,
    readonly opts: GenerateSchemaOptions = {},
  ) {}

  /** `$ref` to a component for `serializer` (registering it). */
  refFor(serializer: any, opts: JSONSchemaOptions = {}): JSONSchema {
    const mode = opts.mode ?? 'output'
    const base = this.componentBaseName(serializer)
    let name = mode === 'input' ? (opts.partial ? `Patched${base}Request` : `${base}Request`) : base
    const owner = this.componentKey(serializer)
    let n = 2
    while (this.componentOwners.has(name) && this.componentOwners.get(name) !== owner)
      name = `${name.replace(/\d+$/, '')}${n++}`
    if (!this.componentOwners.has(name)) {
      this.componentOwners.set(name, owner)
      this.schemas[name] = {}
      const schema = serializer.fieldSchema({ ...opts, ref: this.refCallback, _inline: serializer })
      delete schema.title
      this.schemas[name] = schema
    }
    return { $ref: `#/components/schemas/${name}` }
  }

  readonly refCallback = (serializer: any, opts: JSONSchemaOptions): JSONSchema | undefined => {
    if (opts._inline === serializer) return undefined
    if (!(serializer instanceof Serializer)) return undefined
    return this.refFor(serializer, { mode: opts.mode, partial: opts.partial })
  }

  componentKey(serializer: any): any {
    const ctor = serializer.constructor
    // Generated nested ModelSerializers are distinct classes per field; key them by model + depth.
    if (ctor.name === 'NestedSerializer' && ctor.Meta?.model)
      return `nested:${ctor.Meta.model._meta?.label}:${ctor.Meta.depth}`
    return ctor
  }

  componentBaseName(serializer: any): string {
    const schemaName = serializer.constructor.componentName ?? serializer.componentName
    if (schemaName) return schemaName
    const ctor = serializer.constructor
    if (ctor.name === 'NestedSerializer' && ctor.Meta?.model) return `${ctor.Meta.model.name}Nested`
    return stripSuffix(ctor.name, 'Serializer') || ctor.name
  }

  uniqueOperationId(id: string): string {
    let out = id
    let n = 2
    while (this.operationIds.has(out)) out = `${id}${n++}`
    this.operationIds.add(out)
    return out
  }

  computeTagPrefix(paths: string[]): string {
    if (this.opts.tagPrefix !== undefined)
      return `/${this.opts.tagPrefix.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/')
    const split = paths.map((p) => p.split('/').filter(Boolean))
    if (!split.length) return '/'
    const minLen = Math.min(...split.map((s) => s.length))
    let common = 0
    while (
      common < minLen - 1 &&
      split.every((s) => s[common] === split[0][common] && !split[0][common].startsWith('{'))
    )
      common++
    return `/${split[0].slice(0, common).join('/')}${common ? '/' : ''}`
  }

  getSchema(): OpenAPIDocument {
    const endpoints = getEndpoints(this.patterns)
    this.tagPrefix = this.computeTagPrefix(endpoints.map((e) => e.path))
    const paths: Record<string, Record<string, unknown>> = {}
    for (const endpoint of endpoints) {
      const view = viewForEndpoint(endpoint)
      if (view.schema === null) continue
      const SchemaCls = view.schema ? null : defaultSchemaClass()
      const schema: AutoSchema = view.schema ?? new SchemaCls!()
      schema.view = view
      const operation = schema.getOperation(endpoint.path, endpoint.method, this)
      if (!operation) continue
      paths[endpoint.path] ??= {}
      paths[endpoint.path][endpoint.method.toLowerCase()] = operation
    }
    const info = {
      title: this.opts.title ?? this.opts.info?.title ?? 'API',
      version: this.opts.version ?? this.opts.info?.version ?? '1.0.0',
      ...(this.opts.description || this.opts.info?.description
        ? { description: this.opts.description ?? this.opts.info?.description }
        : {}),
      ...Object.fromEntries(
        Object.entries(this.opts.info ?? {}).filter(
          ([k]) => !['title', 'version', 'description'].includes(k),
        ),
      ),
    }
    const doc: OpenAPIDocument = { openapi: '3.1.0', info }
    if (this.opts.servers?.length) doc.servers = this.opts.servers
    doc.paths = paths
    const components: Record<string, unknown> = {
      schemas: Object.fromEntries(Object.entries(this.schemas).sort(([a], [b]) => a.localeCompare(b))),
    }
    if (Object.keys(this.securitySchemes).length) components.securitySchemes = this.securitySchemes
    doc.components = components
    return doc
  }
}

function defaultSchemaClass(): any {
  return apiSettings.DEFAULT_SCHEMA_CLASS ?? AutoSchema
}

const ERROR_SCHEMAS: Record<string, JSONSchema> = {
  ErrorDetail: {
    type: 'object',
    properties: { detail: { type: 'string' } },
    required: ['detail'],
  },
  ValidationError: {
    type: 'object',
    description: 'Field name → list of messages; `nonFieldErrors` for object-level errors.',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  },
}

export interface AutoSchemaOptions {
  tags?: string[]
  /** Replaces the model / serializer name in operation ids (`listPosts` → `list${operationIdBase}`). */
  operationIdBase?: string
  /** Component name for the view's serializer. */
  componentName?: string
}

/**
 * Per-view OpenAPI generation (DRF's `AutoSchema`). Set `schema = new AutoSchema({ tags: ['blog'] })` on a
 * view, subclass it to customize, or set `schema = null` to exclude the view.
 */
export class AutoSchema {
  view: any
  tags?: string[]
  operationIdBase?: string
  componentName?: string

  constructor(opts: AutoSchemaOptions = {}) {
    this.tags = opts.tags
    this.operationIdBase = opts.operationIdBase
    this.componentName = opts.componentName
  }

  /** `extendSchema()` overrides for this operation (class-level, then handler-level). */
  getExtension(method: string): SchemaExtension {
    const view = this.view
    const handlerName = view.action ?? method.toLowerCase()
    const classExt = view.constructor?.[SCHEMA_EXTENSION] ?? {}
    let handler = view[handlerName]
    if (typeof handler !== 'function') handler = view[method.toLowerCase()]
    const fnExt = typeof handler === 'function' ? (handler[SCHEMA_EXTENSION] ?? {}) : {}
    const actionSchema = (view.schemaExtension ?? {}) as SchemaExtension
    return { ...classExt, ...actionSchema, ...fnExt }
  }

  getOperation(path: string, method: string, generator: SchemaGenerator): Record<string, unknown> | null {
    const ext = this.getExtension(method)
    if (ext.exclude) return null
    const op: Record<string, unknown> = {}
    op.operationId = generator.uniqueOperationId(ext.operationId ?? this.getOperationId(path, method))
    if (ext.summary) op.summary = ext.summary
    const description = ext.description ?? this.getDescription(path, method)
    if (description) op.description = description
    const params = [
      ...this.getPathParameters(path, method),
      ...this.getPaginationParameters(path, method),
      ...this.getFilterParameters(path, method),
      ...(ext.parameters ?? []),
    ]
    if (params.length) op.parameters = params
    op.tags = ext.tags ?? this.getTags(path, method, generator)
    const body = this.getRequestBody(path, method, generator, ext)
    if (body) op.requestBody = body
    const security = this.getSecurity(generator)
    if (security) op.security = security
    op.responses = this.getResponses(path, method, generator, ext)
    if (ext.deprecated) op.deprecated = true
    if (ext.extensions) Object.assign(op, ext.extensions)
    return op
  }

  getDescription(_path: string, _method: string): string {
    const view = this.view
    const actionDesc = view.action && view.description === undefined ? undefined : view.description
    return actionDesc ?? view.constructor?.description ?? ''
  }

  isListView(path: string, method: string): boolean {
    const view = this.view
    if (view.actionMap && Object.keys(view.actionMap).length) return view.action === 'list'
    if (method.toUpperCase() !== 'GET') return false
    if (typeof view.list !== 'function') return false
    return !/\{[^}]+\}\/?$/.test(path)
  }

  isDetailPath(path: string): boolean {
    return /\{[^}]+\}/.test(path)
  }

  getModel(): any {
    try {
      const qs = typeof this.view.getQueryset === 'function' ? this.view.getQueryset() : this.view.queryset
      if (qs?.model) return qs.model
      if (isModelClass(qs)) return qs
    } catch {}
    return undefined
  }

  getOperationIdBase(_path: string, _method: string, action: string): string {
    if (this.operationIdBase) return this.operationIdBase
    let name: string | undefined = this.getModel()?.name
    if (!name) {
      const s = this.getSerializer('', 'GET')
      if (s) name = stripSuffix(s.constructor.name, 'Serializer')
    }
    if (!name)
      name = stripSuffix(stripSuffix(stripSuffix(this.view.constructor.name, 'APIView'), 'View'), 'ViewSet')
    if (action === 'list' && !name.endsWith('s')) name += 's'
    return name
  }

  getOperationId(path: string, method: string): string {
    const methodName: string = this.view.action ?? method.toLowerCase()
    let action: string
    if (this.isListView(path, method)) action = 'list'
    else if (!(methodName in METHOD_MAPPING)) action = methodName
    else action = METHOD_MAPPING[method.toLowerCase()]
    return action + capfirst(this.getOperationIdBase(path, method, action))
  }

  getTags(path: string, _method: string, generator: SchemaGenerator): string[] {
    if (this.tags) return this.tags
    let p = path
    if (generator.tagPrefix && p.startsWith(generator.tagPrefix)) p = p.slice(generator.tagPrefix.length)
    p = p.replace(/^\//, '')
    const seg = p.split('/')[0] || path.split('/').filter(Boolean)[0] || 'default'
    return [seg.replace(/_/g, '-')]
  }

  getPathParameters(path: string, _method: string): Array<Record<string, unknown>> {
    const model = this.getModel()
    const view = this.view
    const out: Array<Record<string, unknown>> = []
    for (const m of path.matchAll(/\{([^}]+)\}/g)) {
      const name = m[1]
      let schema: Record<string, unknown> = { type: 'string' }
      let description = ''
      const lookupKwarg = view.lookupUrlKwarg ?? view.lookupField
      if (model && name === lookupKwarg) {
        const lookupField = view.lookupField ?? 'pk'
        const f = lookupField === 'pk' ? model._meta.pk : model._meta.getForwardField(lookupField)
        if (f) {
          try {
            const s = f.jsonSchema()
            const type = Array.isArray(s.type) ? s.type.filter((t: string) => t !== 'null')[0] : s.type
            schema = { type: type ?? 'string', ...(s.format ? { format: s.format } : {}) }
          } catch {}
          const verbose = model._meta.verboseName
          if (f.primaryKey) {
            description =
              schema.type === 'integer'
                ? `A unique integer value identifying this ${verbose}.`
                : `A unique value identifying this ${verbose}.`
          } else if (f.unique) description = `A unique value identifying this ${verbose}.`
        }
      }
      out.push({ name, in: 'path', required: true, ...(description ? { description } : {}), schema })
    }
    return out
  }

  allowsFilters(path: string, method: string): boolean {
    if (typeof this.view.getFilterBackends !== 'function') return false
    if (this.view.action !== undefined)
      return (
        ['list', 'retrieve', 'update', 'partialUpdate', 'destroy'].includes(this.view.action) &&
        this.isListView(path, method)
      )
    return method.toUpperCase() === 'GET' && this.isListView(path, method)
  }

  getFilterParameters(path: string, method: string): Array<Record<string, unknown>> {
    if (!this.allowsFilters(path, method)) return []
    const out: Array<Record<string, unknown>> = []
    for (const B of this.view.getFilterBackends())
      out.push(...new B().getSchemaOperationParameters(this.view))
    return out
  }

  getPaginator(): any {
    try {
      return this.view.paginator ?? null
    } catch {
      return null
    }
  }

  getPaginationParameters(path: string, method: string): Array<Record<string, unknown>> {
    if (!this.isListView(path, method)) return []
    const p = this.getPaginator()
    return p ? p.getSchemaOperationParameters(this.view) : []
  }

  /** Serializer instance used for the request/response, or undefined. */
  getSerializer(_path: string, _method: string): any {
    const view = this.view
    if (typeof view.getSerializer !== 'function') return undefined
    try {
      return view.getSerializer()
    } catch {
      return undefined
    }
  }

  mediaTypes(kind: 'request' | 'response'): string[] {
    try {
      if (kind === 'request') {
        return this.view
          .getParsers()
          .map((p: any) => p.mediaType)
          .filter((m: string) => m !== '*/*')
      }
      return this.view
        .getRenderers()
        .map((r: any) => r.mediaType)
        .filter((m: string) => m !== 'text/html')
    } catch {
      return ['application/json']
    }
  }

  /** Turn a serializer class / instance or JSON Schema into a schema (refs for serializers). */
  resolveSchema(value: unknown, generator: SchemaGenerator, opts: JSONSchemaOptions): JSONSchema {
    if (value instanceof BaseSerializer) {
      if (value instanceof Serializer) return generator.refFor(value, opts)
      return value.fieldSchema({ ...opts, ref: generator.refCallback })
    }
    if (typeof value === 'function' && (value as any).prototype instanceof BaseSerializer) {
      return this.resolveSchema(new (value as any)(), generator, opts)
    }
    return (value ?? {}) as JSONSchema
  }

  getRequestBody(
    path: string,
    method: string,
    generator: SchemaGenerator,
    ext: SchemaExtension = {},
  ): Record<string, unknown> | null {
    const m = method.toUpperCase()
    if (!['POST', 'PUT', 'PATCH'].includes(m)) return null
    let schema: JSONSchema
    if (ext.request !== undefined) {
      if (ext.request === null) return null
      schema = this.resolveSchema(ext.request, generator, { mode: 'input', partial: m === 'PATCH' })
    } else {
      const serializer = this.getSerializer(path, method)
      if (!serializer) return null
      schema = this.resolveSchema(serializer, generator, { mode: 'input', partial: m === 'PATCH' })
    }
    const content: Record<string, unknown> = {}
    for (const mt of this.mediaTypes('request')) content[mt] = { schema }
    return { content, required: m !== 'PATCH' }
  }

  getSecurity(generator: SchemaGenerator): Array<Record<string, string[]>> | null {
    let classes: any[] = []
    try {
      classes = this.view.getAuthenticators().map((a: any) => a.constructor)
    } catch {
      return null
    }
    const out: Array<Record<string, string[]>> = []
    for (const cls of classes) {
      const scheme = cls.securityScheme as { name: string; scheme: unknown } | undefined
      if (!scheme?.name) continue
      generator.securitySchemes[scheme.name] = scheme.scheme
      out.push({ [scheme.name]: [] })
    }
    if (!out.length) return null
    if (this.allowsAnonymous()) out.push({})
    return out
  }

  allowsAnonymous(): boolean {
    try {
      const perms = this.view.getPermissions()
      return perms.every((p: any) => p instanceof AllowAny)
    } catch {
      return true
    }
  }

  getResponses(
    path: string,
    method: string,
    generator: SchemaGenerator,
    ext: SchemaExtension = {},
  ): Record<string, unknown> {
    const m = method.toUpperCase()
    const responses: Record<string, unknown> = {}
    const content = (schema: JSONSchema) =>
      Object.fromEntries(this.mediaTypes('response').map((mt) => [mt, { schema }]))
    const success = m === 'POST' ? '201' : m === 'DELETE' ? '204' : '200'
    const ref = (name: string) => {
      generator.schemas[name] ??= ERROR_SCHEMAS[name]
      generator.componentOwners.set(name, name)
      return { $ref: `#/components/schemas/${name}` }
    }

    const custom = ext.responses
    const isStatusMap =
      custom !== undefined &&
      custom !== null &&
      typeof custom === 'object' &&
      !(custom instanceof BaseSerializer) &&
      Object.keys(custom).length > 0 &&
      Object.keys(custom).every((k) => /^\d{3}$|^default$/.test(k))
    if (isStatusMap) {
      for (const [code, value] of Object.entries(custom as Record<string, unknown>)) {
        if (value === null) responses[code] = { description: 'No response body' }
        else if (
          value &&
          typeof value === 'object' &&
          'description' in (value as object) &&
          !(value instanceof BaseSerializer)
        )
          responses[code] = value
        else
          responses[code] = {
            description: '',
            content: content(this.resolveSchema(value, generator, { mode: 'output' })),
          }
      }
      return responses
    }

    if (m === 'DELETE' && custom === undefined) {
      responses['204'] = { description: 'No response body' }
    } else {
      let item: JSONSchema | null = null
      if (custom !== undefined)
        item = custom === null ? null : this.resolveSchema(custom, generator, { mode: 'output' })
      else {
        const serializer = this.getSerializer(path, method)
        item = serializer ? this.resolveSchema(serializer, generator, { mode: 'output' }) : {}
      }
      if (item === null) responses[success] = { description: 'No response body' }
      else {
        let schema = item
        if (this.isListView(path, method)) {
          schema = { type: 'array', items: item }
          const paginator = this.getPaginator()
          if (paginator) schema = paginator.getPaginatedResponseSchema(schema)
        }
        responses[success] = { description: '', content: content(schema) }
      }
    }
    if (['POST', 'PUT', 'PATCH'].includes(m) || this.getFilterParameters(path, method).length) {
      responses['400'] = { description: 'Invalid input', content: content(ref('ValidationError')) }
    }
    if (!this.allowsAnonymous()) {
      responses['401'] = { description: 'Not authenticated', content: content(ref('ErrorDetail')) }
      responses['403'] = { description: 'Permission denied', content: content(ref('ErrorDetail')) }
    }
    if (this.isDetailPath(path))
      responses['404'] = { description: 'Not found', content: content(ref('ErrorDetail')) }
    try {
      if (this.view.getThrottles().length)
        responses['429'] = { description: 'Too many requests', content: content(ref('ErrorDetail')) }
    } catch {}
    return responses
  }
}

/**
 * Generate an OpenAPI 3.1 document from URL patterns or a router:
 *
 * ```ts
 * const doc = generateSchema(router, { title: 'Blog API', version: '1.0.0', prefix: 'api/' })
 * const doc = generateSchema(urlpatterns, { title: 'Blog API' })
 * ```
 */
export function generateSchema(
  source: UrlPatterns | { urls: UrlPatterns },
  opts: GenerateSchemaOptions = {},
): OpenAPIDocument {
  let patterns: UrlPatterns = Array.isArray(source) ? source : source.urls
  if (opts.prefix) patterns = [path(opts.prefix.replace(/^\//, ''), include(patterns))] as UrlPatterns
  return new SchemaGenerator(patterns, opts).getSchema()
}

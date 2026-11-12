import { capfirst, humanize, kebabCase } from './utils'

/** Marker on methods decorated with `@action`. */
export const ACTION: unique symbol = Symbol.for('ghuri.rest.action') as any
/** Options carried by the decorator returned from `action()` (for `static actions = {...}`). */
export const ACTION_OPTIONS: unique symbol = Symbol.for('ghuri.rest.actionOptions') as any
/** Marker for `extendSchema()` overrides. */
export const SCHEMA_EXTENSION: unique symbol = Symbol.for('ghuri.rest.schemaExtension') as any

export interface ActionOptions {
  /** Route on the detail URL (`/posts/<pk>/publish/`) or the list URL (`/posts/recent/`). */
  detail: boolean
  /** HTTP methods (default `['get']`). */
  methods?: string[]
  /** URL segment (default: the method name in kebab-case, `setPassword` → `set-password`). */
  urlPath?: string
  /** URL name suffix: `<basename>-<urlName>` (default: kebab-case method name). */
  urlName?: string
  /** View name for the browsable API (default: humanized method name). */
  name?: string
  suffix?: string
  description?: string
  /** Any view attribute to override for this action: `permissionClasses`, `serializerClass`, … */
  [initkwarg: string]: unknown
}

/** Normalized information about an extra action (`router.registry[i].actions`, `ViewSet.getExtraActions()`). */
export interface ActionInfo {
  /** Method name on the viewset. */
  name: string
  detail: boolean
  /** Lower-case HTTP methods. */
  methods: string[]
  urlPath: string
  urlName: string
  /** HTTP method → method name. */
  mapping: Record<string, string>
  /** View attributes overridden for this route (permissionClasses, serializerClass, name, …). */
  kwargs: Record<string, unknown>
}

/** Normalize `@action` options for method `name`. */
export function actionInfo(name: string, opts: ActionOptions): ActionInfo {
  const { detail, methods, urlPath, urlName, ...kwargs } = opts
  if (typeof detail !== 'boolean') throw new TypeError("@action() missing required argument: 'detail'")
  const ms = (methods ?? ['get']).map((m) => m.toLowerCase())
  if (kwargs.name === undefined && kwargs.suffix === undefined) kwargs.name = capfirst(humanize(name))
  return {
    name,
    detail,
    methods: ms,
    urlPath: urlPath ?? kebabCase(name),
    urlName: urlName ?? kebabCase(name),
    mapping: Object.fromEntries(ms.map((m) => [m, name])),
    kwargs,
  }
}

export interface ActionDecorator {
  (value: any, context?: any, descriptor?: PropertyDescriptor): any
  readonly [ACTION_OPTIONS]: ActionOptions
}

/**
 * Legacy (`experimentalDecorators`) method decorators compiled by Babel with decorator metadata — e.g. jiti, the
 * TypeScript loader of the `ghuri` CLI — may receive the class prototype instead of the property descriptor
 * (the no-op metadata decorators return their target). Recover the real descriptor in that case.
 */
function legacyMethodDescriptor(
  target: unknown,
  key: unknown,
  descriptor: unknown,
): PropertyDescriptor | undefined {
  if (typeof key !== 'string' && typeof key !== 'symbol') return undefined
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return undefined
  if (descriptor !== undefined && descriptor !== target) return undefined
  const real = Object.getOwnPropertyDescriptor(target, key)
  return real && typeof real.value === 'function' ? real : undefined
}

function mark(fn: any, name: string, opts: ActionOptions): void {
  if (typeof fn !== 'function') throw new TypeError('@action() can only decorate methods.')
  fn[ACTION] = actionInfo(name, opts)
}

/**
 * Mark a viewset method as a routable extra action (DRF's `@action`). Works as a TC39 decorator, as a
 * legacy (`experimentalDecorators`) decorator, as a wrapper, or in a static map:
 *
 * ```ts
 * class PostViewSet extends ModelViewSet {
 *   @action({ detail: true, methods: ['post'], permissionClasses: [IsAdminUser] })
 *   async publish(request: APIRequest) { ... }
 * }
 * // without decorators:
 * class PostViewSet extends ModelViewSet {
 *   static actions = { publish: action({ detail: true, methods: ['post'] }) }
 *   async publish(request: APIRequest) { ... }
 * }
 * ```
 */
export function action(opts: ActionOptions): ActionDecorator {
  const decorator = ((value: any, context?: any, descriptor?: PropertyDescriptor) => {
    if (descriptor && typeof descriptor.value === 'function') {
      mark(descriptor.value, String(context), opts)
      return descriptor
    }
    if (typeof value === 'function') {
      const name =
        context && typeof context === 'object' && 'name' in context ? String(context.name) : value.name
      mark(value, name, opts)
      return value
    }
    const legacy = legacyMethodDescriptor(value, context, descriptor)
    if (legacy) {
      mark(legacy.value, String(context), opts)
      return legacy
    }
    throw new TypeError('@action() can only decorate methods.')
  }) as ActionDecorator
  Object.defineProperty(decorator, ACTION_OPTIONS, { value: opts })
  return decorator
}

/** Collect extra actions of a viewset class: decorated methods plus `static actions`. */
export function getExtraActions(viewset: any): ActionInfo[] {
  const found = new Map<string, ActionInfo>()
  const chain: any[] = []
  for (let p = viewset?.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) chain.unshift(p)
  for (const proto of chain) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue
      const desc = Object.getOwnPropertyDescriptor(proto, key)
      const fn = desc?.value
      if (typeof fn === 'function' && fn[ACTION])
        found.set(key, { ...fn[ACTION], name: key, mapping: remap(fn[ACTION], key) })
    }
  }
  const staticChain: any[] = []
  for (let c = viewset; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) staticChain.unshift(c)
  for (const cls of staticChain) {
    if (!Object.hasOwn(cls, 'actions') || !cls.actions || typeof cls.actions !== 'object') continue
    for (const [key, spec] of Object.entries(cls.actions as Record<string, any>)) {
      const opts: ActionOptions | undefined =
        spec?.[ACTION_OPTIONS] ?? (spec && typeof spec === 'object' ? spec : undefined)
      if (!opts) continue
      if (typeof viewset.prototype[key] !== 'function') {
        throw new TypeError(`${viewset.name}.actions.${key}: the viewset has no method named '${key}'.`)
      }
      found.set(key, actionInfo(key, opts))
    }
  }
  return [...found.values()]
}

function remap(info: ActionInfo, name: string): Record<string, string> {
  return Object.fromEntries(info.methods.map((m) => [m, name]))
}

export interface SchemaExtension {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  /** Leave the operation out of the schema. */
  exclude?: boolean
  /** Request body: a serializer class / instance, a JSON Schema, or null for none. */
  request?: unknown
  /** Response(s): a serializer / JSON Schema, or `{ 200: ..., 404: null }`. */
  responses?: unknown
  /** Extra OpenAPI parameter objects. */
  parameters?: Array<Record<string, unknown>>
  /** Merged into the operation object last. */
  extensions?: Record<string, unknown>
}

/**
 * Override generated OpenAPI for a method (or every method of a view class), like drf-spectacular's
 * `@extend_schema`. Usable as a TC39 / legacy decorator or as a wrapper: `extendSchema({...})(fn)`.
 */
export function extendSchema(
  ext: SchemaExtension,
): (value: any, context?: any, descriptor?: PropertyDescriptor) => any {
  return (value: any, context?: any, descriptor?: PropertyDescriptor) => {
    const legacy = legacyMethodDescriptor(value, context, descriptor)
    if (legacy) descriptor = legacy
    const target = descriptor && typeof descriptor.value === 'function' ? descriptor.value : value
    if (typeof target !== 'function')
      throw new TypeError('extendSchema() can only decorate methods or classes.')
    target[SCHEMA_EXTENSION] = { ...(target[SCHEMA_EXTENSION] ?? {}), ...ext }
    return descriptor ?? value
  }
}

// Internal helpers shared by the REST modules.

export type MaybePromise<T> = T | Promise<T>
export type Constructor<T = object> = new (...args: any[]) => T
export type AbstractConstructor<T = object> = abstract new (...args: any[]) => T

export function isPlainObject(v: unknown): v is Record<string, any> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).then === 'function'
}

/** Is `v` a QuerySet (without importing the ORM at module level)? */
export function isQuerySet(v: unknown): boolean {
  return !!v && typeof v === 'object' && (v as any)._isQuerySet === true
}

/** Is `v` a Manager / related manager (has `getQueryset()` and `all()`)? */
export function isManager(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as any).getQueryset === 'function' &&
    typeof (v as any).all === 'function' &&
    !isQuerySet(v)
  )
}

/** Is `v` a model instance? */
export function isModelInstance(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    '_state' in (v as object) &&
    typeof (v as any).constructor?._meta === 'object'
  )
}

/** Is `v` a model class? */
export function isModelClass(v: unknown): boolean {
  return typeof v === 'function' && typeof (v as any)._meta === 'object' && !!(v as any).prototype
}

export function capfirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** `createdAt` → `created at`, `created_at` → `created at`. */
export function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim()
}

/** `publishAll` → `publish-all`, `set_password` → `set-password`. */
export function kebabCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}

/** `partial_update` / `partial-update` → `partialUpdate`. */
export function camelCase(s: string): string {
  return s.replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
}

/** Fill DRF-style `{name}` placeholders. */
export function formatMessage(template: string, params: Record<string, unknown> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
}

/** JSON type name of a value, for error messages (`Expected a list of items but got type "str"`). */
export function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'string') return 'str'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'object') return v instanceof Blob ? 'file' : 'dict'
  return typeof v
}

/** Resolve a value that may be a function returning it. */
export function resolveValue<T>(v: T | (() => T)): T {
  return typeof v === 'function' ? (v as () => T)() : v
}

/** Replace (or add) a query parameter of an absolute or relative URL. */
export function replaceQueryParam(url: string, key: string, value: string | number): string {
  const u = new URL(url, 'http://placeholder')
  u.searchParams.set(key, String(value))
  return u.origin === 'http://placeholder' ? `${u.pathname}${u.search}${u.hash}` : u.toString()
}

/** Remove a query parameter of a URL. */
export function removeQueryParam(url: string, key: string): string {
  const u = new URL(url, 'http://placeholder')
  u.searchParams.delete(key)
  return u.origin === 'http://placeholder' ? `${u.pathname}${u.search}${u.hash}` : u.toString()
}

/** Base64 (UTF-8 safe) without Node's Buffer. */
export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function b64decode(s: string): string {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** Positive integer from a string (DRF `_positive_int`). */
export function positiveInt(value: unknown, opts: { strict?: boolean; cutoff?: number | null } = {}): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n) || String(value).trim() === '' || !/^\s*[+-]?\d+\s*$/.test(String(value)))
    throw new TypeError(`invalid integer ${String(value)}`)
  if (n < 0 || (n === 0 && opts.strict)) throw new RangeError('not a positive integer')
  if (opts.cutoff !== undefined && opts.cutoff !== null) return Math.min(n, opts.cutoff)
  return n
}

/** Name of a class without a trailing suffix: `PostViewSet` → `Post`. */
export function stripSuffix(name: string, ...suffixes: string[]): string {
  for (const s of suffixes) if (name.endsWith(s) && name.length > s.length) return name.slice(0, -s.length)
  return name
}

/** Turn a camelCase class/attribute name into words: `PostList` → `Post List`. */
export function camelToWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
}

/** Read an attribute that may be declared on the instance or (Python-like) as a static on the class. */
export function classAttr<T>(obj: object, name: string): T | undefined {
  const v = (obj as any)[name]
  if (v !== undefined) return v as T
  return (obj.constructor as any)?.[name] as T | undefined
}

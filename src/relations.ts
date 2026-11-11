import {
  ValidationError as CoreValidationError,
  MultipleObjectsReturned,
  NoReverseMatch,
  ObjectDoesNotExist,
  Resolver404,
  resolve,
  resolverMatch,
  reverse,
} from '@ghuri/core'
import {
  empty,
  Field,
  type FieldOptions,
  getAttribute,
  type JSONSchema,
  type JSONSchemaOptions,
} from './fields'
import { isHtmlInput } from './parsers'
import { isManager, isModelInstance, isPromiseLike, isQuerySet, typeName } from './utils'

/** Stand-in for a related object when only its pk is needed (DRF's `PKOnlyObject`). */
export class PKOnlyObject {
  constructor(readonly pk: unknown) {}
  toString(): string {
    return String(this.pk)
  }
}

/** Querysets for relational fields: a QuerySet, a Manager, a model class, or a function returning one. */
export type QuerysetLike = any

export interface RelatedFieldOptions extends FieldOptions {
  queryset?: QuerysetLike
  /** Wrap in a `ManyRelatedField` (to-many relation). */
  many?: boolean
  allowEmpty?: boolean
  htmlCutoff?: number
  htmlCutoffText?: string
}

const MANY_RELATION_KWARGS = [
  'readOnly',
  'writeOnly',
  'required',
  'default',
  'initial',
  'source',
  'label',
  'helpText',
  'style',
  'errorMessages',
  'allowEmpty',
  'htmlCutoff',
  'htmlCutoffText',
  'allowNull',
] as const

function toQueryset(qs: QuerysetLike): any {
  let q = qs
  if (typeof q === 'function' && !q._meta) q = q()
  if (q && typeof q === 'function' && q._meta) q = q._defaultManager
  if (isManager(q) || isQuerySet(q)) return q.all()
  return q
}

function isLookupFailure(err: unknown): boolean {
  return err instanceof CoreValidationError || err instanceof TypeError || err instanceof RangeError
}

/**
 * Base class for relational fields (DRF's `RelatedField`). Writable fields need a `queryset` (or an
 * overridden `getQueryset()`). `{ many: true }` returns a `ManyRelatedField` wrapping this field.
 */
export class RelatedField extends Field {
  queryset?: QuerysetLike
  htmlCutoff?: number
  htmlCutoffText?: string

  // biome-ignore lint/correctness/noUnreachableSuper: `many: true` returns a list wrapper before super() (DRF's __new__)
  constructor(opts: RelatedFieldOptions = {}) {
    if (opts.many) {
      // DRF's `many_init`: return a ManyRelatedField wrapping a child of the requested class.
      // biome-ignore lint/correctness/noConstructorReturn: mirrors DRF's `__new__` for `many=True`
      return (new.target as any).manyInit(opts)
    }
    super(opts)
    this.queryset = opts.queryset
    this.htmlCutoff = opts.htmlCutoff
    this.htmlCutoffText = opts.htmlCutoffText
    const overridesGetQueryset = (this as any).getQueryset !== RelatedField.prototype.getQueryset
    if (!this.readOnly && this.queryset === undefined && !overridesGetQueryset) {
      throw new TypeError(
        'Relational field must provide a `queryset` argument, override `getQueryset()`, or set readOnly=`true`.',
      )
    }
    if (this.queryset !== undefined && this.readOnly) {
      throw new TypeError(
        'Relational fields should not provide a `queryset` argument when setting readOnly=`true`.',
      )
    }
  }

  /** `PrimaryKeyRelatedField.many({ queryset })` — explicit alternative to `{ many: true }`. */
  static many<T extends RelatedField>(
    this: new (
      opts: any,
    ) => T,
    opts: RelatedFieldOptions = {},
  ): ManyRelatedField {
    return (this as any).manyInit({ ...opts, many: true })
  }

  static manyInit(this: any, opts: RelatedFieldOptions): ManyRelatedField {
    const { many: _many, allowEmpty, ...childOpts } = opts
    const child = new this(childOpts)
    const listKwargs: Record<string, unknown> = { childRelation: child }
    for (const k of MANY_RELATION_KWARGS) {
      const v = (opts as any)[k]
      if (v !== undefined) listKwargs[k] = v
    }
    if (allowEmpty !== undefined) listKwargs.allowEmpty = allowEmpty
    return new ManyRelatedField(listKwargs as any)
  }

  override async runValidation(data: unknown = empty): Promise<any> {
    // An empty string from a form select means "no relation".
    return super.runValidation(data === '' ? null : data)
  }

  /** Fresh queryset for lookups (re-evaluated per request). */
  getQueryset(): any {
    if (this.queryset === undefined) {
      throw new TypeError(`${this.constructor.name} has no queryset; pass one or override getQueryset().`)
    }
    return toQueryset(this.queryset)
  }

  /** Return a `PKOnlyObject` instead of loading the related object when only the pk is needed. */
  usePkOnlyOptimization(): boolean {
    return false
  }

  override async getAttribute(instance: any): Promise<any> {
    if (this.usePkOnlyOptimization() && this.sourceAttrs.length) {
      try {
        const owner = await getAttribute(instance, this.sourceAttrs.slice(0, -1))
        const last = this.sourceAttrs[this.sourceAttrs.length - 1]
        if (isModelInstance(owner)) {
          const f = owner.constructor._meta.getForwardField(last)
          if (f && (f.manyToOne || f.oneToOne) && f.attname !== f.name) {
            const raw = owner[f.attname]
            return raw === null || raw === undefined ? null : new PKOnlyObject(raw)
          }
        }
      } catch {
        // fall back to the full lookup
      }
    }
    return super.getAttribute(instance)
  }

  /** Text for an object in choices (`String(obj)`). */
  displayValue(instance: unknown): string {
    return String(instance)
  }

  /** Choices for browsable forms / OPTIONS metadata (loads up to `cutoff` objects). */
  async getChoices(cutoff?: number): Promise<Array<{ value: unknown; displayName: string }>> {
    let qs = this.getQueryset()
    if (!qs) return []
    if (cutoff !== undefined && typeof qs.slice === 'function') qs = qs.slice(0, cutoff)
    const items: any[] = await qs
    const out: Array<{ value: unknown; displayName: string }> = []
    for (const item of items)
      out.push({ value: await this.toRepresentation(item), displayName: this.displayValue(item) })
    return out
  }

  /** JSON Schema type of the related model's primary key. */
  pkSchema(): JSONSchema {
    try {
      const qs = this.queryset !== undefined ? toQueryset(this.queryset) : null
      const model = qs?.model ?? (this.parent as any)?.relatedModelFor?.(this.fieldName)
      const pk = model?._meta?.pk
      if (pk) {
        const s = pk.jsonSchema()
        const type = Array.isArray(s.type) ? s.type.filter((t: string) => t !== 'null') : s.type
        return {
          type: Array.isArray(type) && type.length === 1 ? type[0] : (type ?? 'integer'),
          ...(s.format ? { format: s.format } : {}),
        }
      }
    } catch {}
    return { type: 'integer' }
  }
}

export interface PrimaryKeyRelatedFieldOptions extends RelatedFieldOptions {
  /** Field used to convert the pk (e.g. `new UUIDField()`). */
  pkField?: Field
}

/** Related object as its primary key. */
export class PrimaryKeyRelatedField extends RelatedField {
  static override defaultErrorMessages: Record<string, string> = {
    required: 'This field is required.',
    does_not_exist: 'Invalid pk "{pk_value}" - object does not exist.',
    incorrect_type: 'Incorrect type. Expected pk value, received {data_type}.',
  }
  pkField?: Field

  constructor(opts: PrimaryKeyRelatedFieldOptions = {}) {
    super(opts)
    this.pkField = opts.pkField
  }

  override usePkOnlyOptimization(): boolean {
    return true
  }

  override async toInternalValue(data: unknown): Promise<any> {
    let value = data
    if (this.pkField) value = await this.pkField.toInternalValue(value)
    if (typeof value === 'boolean' || (value !== null && typeof value === 'object')) {
      return this.fail('incorrect_type', { data_type: typeName(value) })
    }
    const qs = this.getQueryset()
    try {
      return await qs.get({ pk: value })
    } catch (err) {
      if (err instanceof ObjectDoesNotExist) return this.fail('does_not_exist', { pk_value: value })
      if (isLookupFailure(err)) return this.fail('incorrect_type', { data_type: typeName(value) })
      throw err
    }
  }

  override async toRepresentation(value: any): Promise<unknown> {
    const pk = value?.pk
    if (this.pkField) return this.pkField.toRepresentation(pk)
    return typeof pk === 'bigint' ? Number(pk) : pk
  }

  override fieldSchema(): JSONSchema {
    return this.pkField ? this.pkField.fieldSchema() : this.pkSchema()
  }
}

/** Read-only: the related object's `toString()`. */
export class StringRelatedField extends RelatedField {
  constructor(opts: RelatedFieldOptions = {}) {
    super({ ...opts, readOnly: true })
  }
  override toRepresentation(value: unknown): string {
    return String(value)
  }
  override fieldSchema(): JSONSchema {
    return { type: 'string' }
  }
}

export interface SlugRelatedFieldOptions extends RelatedFieldOptions {
  /** Field on the target used to represent it (e.g. `'username'`). */
  slugField: string
}

/** Related object as one of its (unique) fields. */
export class SlugRelatedField extends RelatedField {
  static override defaultErrorMessages: Record<string, string> = {
    does_not_exist: 'Object with {slug_name}={value} does not exist.',
    invalid: 'Invalid value.',
  }
  slugField: string

  constructor(opts: SlugRelatedFieldOptions) {
    super(opts)
    if (!opts?.slugField) throw new TypeError('The `slugField` argument is required.')
    this.slugField = opts.slugField
  }

  override async toInternalValue(data: unknown): Promise<any> {
    const qs = this.getQueryset()
    try {
      return await qs.get({ [this.slugField]: data })
    } catch (err) {
      if (err instanceof ObjectDoesNotExist)
        return this.fail('does_not_exist', { slug_name: this.slugField, value: data })
      if (err instanceof MultipleObjectsReturned || isLookupFailure(err)) return this.fail('invalid')
      throw err
    }
  }

  override async toRepresentation(obj: any): Promise<unknown> {
    return getAttribute(obj, this.slugField.split('__'))
  }

  override fieldSchema(): JSONSchema {
    try {
      const model = toQueryset(this.queryset)?.model
      const f = model?._meta?.getForwardField(this.slugField)
      if (f) {
        const s = f.jsonSchema()
        const type = Array.isArray(s.type) ? s.type.filter((t: string) => t !== 'null')[0] : s.type
        return { type: type ?? 'string', ...(s.format ? { format: s.format } : {}) }
      }
    } catch {}
    return { type: 'string' }
  }
}

export interface HyperlinkedRelatedFieldOptions extends RelatedFieldOptions {
  /** URL name of the detail view (e.g. `'post-detail'`, or `'api:post-detail'`). */
  viewName: string
  lookupField?: string
  lookupUrlKwarg?: string
  format?: string
}

/** Reverse `viewName`, retrying inside the current request's URL namespace. */
function reverseInNamespace(viewName: string, kwargs: Record<string, unknown>, request: any): string {
  try {
    return reverse(viewName, kwargs)
  } catch (err) {
    if (!(err instanceof NoReverseMatch) || !request?.c) throw err
    const ns = resolverMatch(request.c)?.namespace
    if (!ns || viewName.includes(':')) throw err
    return reverse(`${ns}:${viewName}`, kwargs)
  }
}

/** Related object as the absolute URL of its detail view. */
export class HyperlinkedRelatedField extends RelatedField {
  static override defaultErrorMessages: Record<string, string> = {
    required: 'This field is required.',
    no_match: 'Invalid hyperlink - No URL match.',
    incorrect_match: 'Invalid hyperlink - Incorrect URL match.',
    does_not_exist: 'Invalid hyperlink - Object does not exist.',
    incorrect_type: 'Incorrect type. Expected URL string, received {data_type}.',
  }
  viewName: string
  lookupField: string
  lookupUrlKwarg: string
  format?: string

  constructor(opts: HyperlinkedRelatedFieldOptions) {
    super(opts)
    if (!opts?.viewName) throw new TypeError('The `viewName` argument is required.')
    this.viewName = opts.viewName
    this.lookupField = opts.lookupField ?? 'pk'
    this.lookupUrlKwarg = opts.lookupUrlKwarg ?? this.lookupField
    this.format = opts.format
  }

  override usePkOnlyOptimization(): boolean {
    return this.lookupField === 'pk'
  }

  /** URL of `obj`, or null for unsaved objects. */
  async getUrl(obj: any, viewName: string, request: any): Promise<string | null> {
    if (obj === null || obj === undefined) return null
    let lookupValue = obj[this.lookupField]
    if (isPromiseLike(lookupValue)) lookupValue = await lookupValue
    if (lookupValue === null || lookupValue === undefined || lookupValue === '') return null
    const path = reverseInNamespace(viewName, { [this.lookupUrlKwarg]: lookupValue }, request)
    return request && typeof request.buildAbsoluteUri === 'function' ? request.buildAbsoluteUri(path) : path
  }

  /** Load the object for resolved URL kwargs (override for complex lookups). */
  async getObject(_viewName: string, viewKwargs: Record<string, unknown>): Promise<any> {
    return this.getQueryset().get({ [this.lookupField]: viewKwargs[this.lookupUrlKwarg] })
  }

  override async toInternalValue(data: unknown): Promise<any> {
    if (typeof data !== 'string') return this.fail('incorrect_type', { data_type: typeName(data) })
    let path: string
    try {
      path = new URL(data, 'http://placeholder').pathname
    } catch {
      return this.fail('no_match')
    }
    let match: any
    try {
      match = resolve(path)
    } catch (err) {
      if (err instanceof Resolver404) return this.fail('no_match')
      throw err
    }
    const expected = this.viewName
    const actual: string | undefined = match.viewName
    if (
      !actual ||
      !(actual === expected || actual.endsWith(`:${expected}`) || expected.endsWith(`:${actual}`))
    ) {
      this.fail('incorrect_match')
    }
    try {
      return await this.getObject(match.viewName, match.kwargs)
    } catch (err) {
      if (err instanceof ObjectDoesNotExist) return this.fail('does_not_exist')
      if (isLookupFailure(err)) return this.fail('incorrect_type', { data_type: typeName(data) })
      throw err
    }
  }

  override async toRepresentation(value: any): Promise<string | null> {
    const request = this.context.request
    return this.getUrl(value, this.viewName, request)
  }

  override fieldSchema(): JSONSchema {
    return { type: 'string', format: 'uri' }
  }
}

/** The URL of the object itself (`url` field of HyperlinkedModelSerializer). Read-only. */
export class HyperlinkedIdentityField extends HyperlinkedRelatedField {
  constructor(opts: HyperlinkedRelatedFieldOptions) {
    super({ ...opts, source: '*', readOnly: true })
  }
  override usePkOnlyOptimization(): boolean {
    return false
  }
}

export interface ManyRelatedFieldOptions extends FieldOptions {
  childRelation: RelatedField
  allowEmpty?: boolean
  htmlCutoff?: number
  htmlCutoffText?: string
}

/** A to-many relation: a list of `childRelation` values (DRF's `ManyRelatedField`). */
export class ManyRelatedField extends Field<any[], unknown[]> {
  static override defaultErrorMessages: Record<string, string> = {
    not_a_list: 'Expected a list of items but got type "{input_type}".',
    empty: 'This list may not be empty.',
  }
  override acceptsList = true
  childRelation: RelatedField
  allowEmpty: boolean

  constructor(opts: ManyRelatedFieldOptions) {
    super(opts)
    this.childRelation = opts.childRelation
    this.allowEmpty = opts.allowEmpty ?? true
    this.childRelation.bind('', this)
  }

  override initialDefault(): unknown {
    return []
  }

  override getValue(dictionary: any): unknown {
    if (isHtmlInput(dictionary)) {
      if (!(this.fieldName in dictionary)) return this.root.partial ? empty : []
      const v = dictionary[this.fieldName]
      return Array.isArray(v) ? v : [v]
    }
    return super.getValue(dictionary)
  }

  override async toInternalValue(data: unknown): Promise<any[]> {
    if (typeof data === 'string' || !Array.isArray(data))
      return this.fail('not_a_list', { input_type: typeName(data) })
    if (!this.allowEmpty && data.length === 0) this.fail('empty')
    const out: any[] = []
    for (const item of data) out.push(await this.childRelation.toInternalValue(item))
    return out
  }

  override async getAttribute(instance: any): Promise<any> {
    if (isModelInstance(instance) && (instance.pk === null || instance.pk === undefined)) return []
    let rel = await getAttribute(instance, this.sourceAttrs)
    if (rel === null || rel === undefined) return []
    if (isManager(rel)) rel = await rel.all()
    else if (isQuerySet(rel)) rel = await rel
    return rel
  }

  override async toRepresentation(iterable: any): Promise<unknown[]> {
    const items = Array.isArray(iterable) ? iterable : [...(iterable ?? [])]
    const out: unknown[] = []
    for (const v of items) out.push(await this.childRelation.toRepresentation(v))
    return out
  }

  async getChoices(cutoff?: number): Promise<Array<{ value: unknown; displayName: string }>> {
    return this.childRelation.getChoices(cutoff)
  }

  override fieldSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    const s: JSONSchema = { type: 'array', items: this.childRelation.fieldSchema(opts) }
    if (!this.allowEmpty) s.minItems = 1
    return s
  }
}

/** Is `v` a to-one relational field? */
export function isRelatedField(v: unknown): v is RelatedField {
  return v instanceof RelatedField
}

export { toQueryset as querysetFrom }

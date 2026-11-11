import { ValidationError as CoreValidationError, ImproperlyConfigured } from '@ghuri/core'
import { MaxLengthValidator, MaxValueValidator, MinLengthValidator, MinValueValidator } from '@ghuri/orm'
import { ErrorDetail, type ErrorDetailInput, nonFieldErrorsKey, ValidationError } from './exceptions'
import {
  BooleanField,
  CharField,
  ChoiceField,
  CreateOnlyDefault,
  DateField,
  DateTimeField,
  DecimalField,
  DurationField,
  EmailField,
  empty,
  errorMessagesOf,
  Field,
  type FieldOptions,
  type FieldValidator,
  FileField,
  FloatField,
  HiddenField,
  ImageField,
  IntegerField,
  IPAddressField,
  JSONField,
  type JSONSchema,
  type JSONSchemaOptions,
  ReadOnlyField,
  SkipField,
  SlugField,
  setValue,
  TimeField,
  URLField,
  UUIDField,
} from './fields'
import { isHtmlInput } from './parsers'
import {
  HyperlinkedIdentityField,
  HyperlinkedRelatedField,
  ManyRelatedField,
  PKOnlyObject,
  PrimaryKeyRelatedField,
  RelatedField,
  SlugRelatedField,
} from './relations'
import { apiSettings } from './settings'
import {
  capfirst,
  isManager,
  isModelInstance,
  isPlainObject,
  isQuerySet,
  type MaybePromise,
  typeName,
} from './utils'
import { UniqueTogetherValidator, UniqueValidator } from './validators'

export interface SerializerOptions<I = any> extends FieldOptions {
  /** Object (or list, with `many`) to serialize / update. */
  instance?: I | null
  /** Input data to validate. */
  data?: unknown
  /** Partial update: missing fields are not required (PATCH). */
  partial?: boolean
  /** Extra context (`{ request, view, format }` in generic views). */
  context?: Record<string, any>
  /** Serialize a list: returns a `ListSerializer` wrapping this serializer. */
  many?: boolean
  allowEmpty?: boolean
  maxLength?: number
  minLength?: number
}

const LIST_SERIALIZER_KWARGS = [
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
  'allowNull',
  'instance',
  'data',
  'partial',
  'context',
  'allowEmpty',
  'maxLength',
  'minLength',
] as const

/** DRF's `as_serializer_error`: any validation error as `{ field: [...], nonFieldErrors: [...] }`. */
export function asSerializerError(err: unknown): Record<string, ErrorDetailInput> | null {
  const detail = errorMessagesOf(err)
  if (detail === null) return null
  const key = nonFieldErrorsKey()
  if (Array.isArray(detail)) return { [key]: detail }
  if (detail instanceof ErrorDetail || typeof detail === 'string') return { [key]: [detail] }
  const out: Record<string, ErrorDetailInput> = {}
  for (const [k, v] of Object.entries(detail)) {
    out[k] = Array.isArray(v) || (v && typeof v === 'object' && !(v instanceof ErrorDetail)) ? v : [v]
  }
  return out
}

function hasErrors(errors: unknown): boolean {
  if (!errors) return false
  if (Array.isArray(errors)) return errors.some((e) => hasErrors(e) || (typeof e === 'string' && e))
  if (typeof errors === 'object') return Object.keys(errors).length > 0
  return !!errors
}

/**
 * Shared machinery of `Serializer` and `ListSerializer` (DRF's `BaseSerializer`):
 * `await isValid()`, `validatedData`, `errors`, `await save()`, `await getData()` / `data`.
 */
export class BaseSerializer<I = any> extends Field<any, any> {
  instance?: I | null
  initialData: unknown
  partial!: boolean
  _context!: Record<string, any>
  _validatedData: any
  _errors: any
  _errorException?: ValidationError
  _data: any

  // biome-ignore lint/correctness/noUnreachableSuper: `many: true` returns a list wrapper before super() (DRF's __new__)
  constructor(opts: SerializerOptions<I> | I = {} as SerializerOptions<I>) {
    let o: SerializerOptions<I> = opts as SerializerOptions<I>
    if (isModelInstance(opts)) o = { instance: opts as I }
    if (o?.many) {
      // DRF's `many_init`: `new PostSerializer({ many: true })` is a ListSerializer of PostSerializer.
      // biome-ignore lint/correctness/noConstructorReturn: mirrors DRF's `__new__` for `many=True`
      return (new.target as any).manyInit(o)
    }
    const {
      instance,
      data,
      partial,
      context,
      many: _m,
      allowEmpty: _a,
      maxLength: _x,
      minLength: _n,
      ...fieldOpts
    } = o ?? {}
    super(fieldOpts)
    this.instance = instance
    this.initialData = data === undefined ? empty : data
    this.partial = partial ?? false
    this._context = context ?? {}
    this._validatedData = undefined
    this._errors = undefined
    this._data = undefined
  }

  /** `PostSerializer.many({ instance: posts })` — typed alternative to `{ many: true }`. */
  static many<T extends BaseSerializer>(
    this: new (
      opts?: any,
    ) => T,
    opts: SerializerOptions = {},
  ): ListSerializer {
    return (this as any).manyInit({ ...opts, many: true })
  }

  static manyInit(this: any, opts: SerializerOptions): ListSerializer {
    const { many: _many, allowEmpty, maxLength, minLength, instance: _i, data: _d, ...childOpts } = opts
    const child = new this({ ...childOpts, context: opts.context, partial: opts.partial })
    const listKwargs: Record<string, unknown> = { child }
    for (const k of LIST_SERIALIZER_KWARGS) {
      const v = (opts as any)[k]
      if (v !== undefined) listKwargs[k] = v
    }
    if (allowEmpty !== undefined) listKwargs.allowEmpty = allowEmpty
    if (maxLength !== undefined) listKwargs.maxLength = maxLength
    if (minLength !== undefined) listKwargs.minLength = minLength
    const ListCls = this.Meta?.listSerializerClass ?? ListSerializer
    return new ListCls(listKwargs)
  }

  /** JSON Schema of a serializer class (see `jsonSchema()` on instances). */
  static jsonSchema(this: new (opts?: any) => BaseSerializer, opts: JSONSchemaOptions = {}): JSONSchema {
    return new this().jsonSchema(opts)
  }

  /** Context passed to the root serializer. */
  override get context(): Record<string, any> {
    return this._parent ? super.context : this._context
  }

  /** Validate `data`. With `{ raiseException: true }` a `ValidationError` (400) is thrown on errors. */
  async isValid(opts: { raiseException?: boolean } = {}): Promise<boolean> {
    if (this.initialData === empty) {
      throw new TypeError(
        'Cannot call `.isValid()` as no `data` was passed when instantiating the serializer instance.',
      )
    }
    if (this._validatedData === undefined) {
      try {
        this._validatedData = await this.runValidation(this.initialData)
        this._errors = this.emptyErrors()
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err
        this._validatedData = this.emptyErrors()
        this._errors = err.detail
        this._errorException = err
      }
    }
    const invalid = hasErrors(this._errors)
    if (invalid && opts.raiseException) throw this._errorException ?? new ValidationError(this._errors)
    return !invalid
  }

  emptyErrors(): any {
    return {}
  }

  /** Validation errors (after `isValid()`), DRF-shaped: `{ field: ['msg'], nonFieldErrors: [...] }`. */
  get errors(): any {
    if (this._errors === undefined)
      throw new TypeError('You must call `.isValid()` before accessing `.errors`.')
    return this._errors
  }

  /** Validated data (after a successful `isValid()`). */
  get validatedData(): any {
    if (this._validatedData === undefined) {
      throw new TypeError('You must call `.isValid()` before accessing `.validatedData`.')
    }
    return this._validatedData
  }

  /** Output representation; computed by `await getData()` (relations are async), then cached here. */
  get data(): any {
    if (this._data === undefined) {
      throw new TypeError(
        'Serializer data is computed asynchronously: call `await serializer.getData()` first (afterwards `.data` returns the cached value).',
      )
    }
    return this._data
  }

  /** Compute (and cache) the output representation (DRF's `.data`). */
  async getData(): Promise<any> {
    if (this.initialData !== empty && this._validatedData === undefined) {
      throw new TypeError(
        'When a serializer is passed a `data` keyword argument you must call `.isValid()` before attempting to access the serialized `.data` representation.\nYou should either call `.isValid()` first, or access `.initialData` instead.',
      )
    }
    if (this._data === undefined) {
      if (this.instance !== undefined && this.instance !== null && !hasErrors(this._errors)) {
        this._data = await this.toRepresentation(this.instance)
      } else if (this._validatedData !== undefined && !hasErrors(this._errors)) {
        this._data = await this.toRepresentation(this._validatedData)
      } else {
        this._data = this.getInitial()
      }
    }
    return this._data
  }

  /** Create or update `instance` from `validatedData` merged with `extra` (`save({ author: user })`). */
  async save(extra: Record<string, unknown> = {}): Promise<I> {
    if (this._errors === undefined)
      throw new TypeError('You must call `.isValid()` before calling `.save()`.')
    if (hasErrors(this._errors))
      throw new TypeError('You cannot call `.save()` on a serializer with invalid data.')
    if (this._data !== undefined) {
      throw new TypeError(
        'You cannot call `.save()` after accessing `serializer.data`. If you need to access data before committing to the database then inspect `serializer.validatedData` instead.',
      )
    }
    const validated = this.mergeExtra(extra)
    if (this.instance !== undefined && this.instance !== null) {
      const updated = await this.update(this.instance, validated)
      if (updated === undefined || updated === null)
        throw new TypeError('`update()` did not return an object instance.')
      this.instance = updated
    } else {
      const created = await this.create(validated)
      if (created === undefined || created === null)
        throw new TypeError('`create()` did not return an object instance.')
      this.instance = created
    }
    return this.instance as I
  }

  mergeExtra(extra: Record<string, unknown>): any {
    return { ...this.validatedData, ...extra }
  }

  create(_validatedData: any): MaybePromise<I> {
    throw new TypeError(`\`create()\` must be implemented on ${this.constructor.name}.`)
  }

  update(_instance: I, _validatedData: any): MaybePromise<I> {
    throw new TypeError(`\`update()\` must be implemented on ${this.constructor.name}.`)
  }
}

/**
 * A serializer with declared fields (DRF's `Serializer`). Declare fields as class properties:
 *
 * ```ts
 * class CommentSerializer extends Serializer {
 *   email = new EmailField()
 *   content = new CharField({ maxLength: 200 })
 *   created = new DateTimeField({ readOnly: true })
 *   validateContent(value: string) { if (value.includes('spam')) throw new ValidationError('No spam'); return value }
 *   async create(data) { return Comment.objects.create(data) }
 * }
 * const s = new CommentSerializer({ data: request.data })
 * if (await s.isValid()) await s.save()
 * ```
 */
export class Serializer<I = any> extends BaseSerializer<I> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Invalid data. Expected a dictionary, but got {datatype}.',
  }
  /** Serializer-level options; ModelSerializer reads `model`, `fields`, … from here. */
  static Meta?: Record<string, any>
  _fields?: Record<string, Field>

  /** Fields declared as class properties (instances of `Field`), in declaration order. */
  declaredFields(): Record<string, Field> {
    const out: Record<string, Field> = {}
    const statics = (this.constructor as any).declaredFields
    if (statics && typeof statics === 'object')
      for (const [k, v] of Object.entries(statics)) if (v instanceof Field) out[k] = v
    for (const key of Object.keys(this)) {
      if (key.startsWith('_')) continue
      const v = (this as any)[key]
      if (v instanceof Field && v !== this._parent) out[key] = v
    }
    return out
  }

  /** The fields of this serializer (override to customize); `fields` binds them. */
  getFields(): Record<string, Field> {
    return { ...this.declaredFields() }
  }

  /** Bound fields by name. */
  get fields(): Record<string, Field> {
    if (!this._fields) {
      const fields = this.getFields()
      for (const [name, field] of Object.entries(fields)) field.bind(name, this)
      this._fields = fields
    }
    return this._fields
  }

  get readableFields(): Field[] {
    return Object.values(this.fields).filter((f) => !f.writeOnly)
  }

  get writableFields(): Field[] {
    return Object.values(this.fields).filter((f) => !f.readOnly)
  }

  override getInitial(): any {
    if (this.initialData !== empty) {
      if (!this.initialData || typeof this.initialData !== 'object') return {}
      const out: Record<string, unknown> = {}
      for (const f of this.readableFields) {
        const v = f.getValue(this.initialData)
        if (v !== empty) out[f.fieldName] = v
      }
      return out
    }
    const out: Record<string, unknown> = {}
    for (const f of this.readableFields) out[f.fieldName] = f.getInitial()
    return out
  }

  override getValue(dictionary: any): unknown {
    if (isHtmlInput(dictionary)) {
      // Nested HTML input (`author.name`) is not supported; a JSON string is accepted.
      const v = dictionary[this.fieldName]
      if (v === undefined) return empty
      if (typeof v === 'string') {
        try {
          return JSON.parse(v)
        } catch {
          return v
        }
      }
      return v
    }
    return super.getValue(dictionary)
  }

  override getValidators(): FieldValidator[] {
    const meta = (this.constructor as any).Meta
    return [...(meta?.validators ?? []), ...this.validators]
  }

  override async runValidation(data: unknown = empty): Promise<any> {
    const [isEmpty, value] = this.validateEmptyValues(data)
    if (isEmpty) return value
    let validated = await this.toInternalValue(value)
    try {
      await this.runValidators(validated)
      validated = await this.validate(validated)
      if (validated === undefined) throw new TypeError('.validate() should return the validated data')
    } catch (err) {
      const detail = asSerializerError(err)
      if (detail === null) throw err
      throw new ValidationError(detail)
    }
    return validated
  }

  /** Values of read-only fields with defaults (so serializer-level validators see them). */
  async readOnlyDefaults(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    for (const f of Object.values(this.fields)) {
      if (!f.readOnly || f.default === empty || f.source === '*' || f.source?.includes('.')) continue
      try {
        out[f.source!] = await f.getDefault()
      } catch (err) {
        if (!(err instanceof SkipField)) throw err
      }
    }
    return out
  }

  override async runValidators(value: unknown): Promise<void> {
    const toValidate = isPlainObject(value) ? { ...(await this.readOnlyDefaults()), ...value } : value
    const validators = this.getValidators()
    if (!validators.length) return
    for (const v of validators) {
      try {
        if (typeof v === 'function') await v(toValidate, this)
        else await v.validate(toValidate, this)
      } catch (err) {
        const detail = asSerializerError(err)
        if (detail === null) throw err
        throw new ValidationError(detail)
      }
    }
  }

  /** Dict of primitives → dict of validated values; collects per-field errors and `validateX()` hooks. */
  override async toInternalValue(data: unknown): Promise<Record<string, any>> {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data instanceof Blob) {
      const msg = this.errorMessages.invalid.replace('{datatype}', typeName(data))
      throw new ValidationError({ [nonFieldErrorsKey()]: [new ErrorDetail(msg, 'invalid')] }, 'invalid')
    }
    const ret: Record<string, any> = {}
    const errors: Record<string, ErrorDetailInput> = {}
    for (const field of this.writableFields) {
      const hook = (this as any)[`validate${capfirst(field.fieldName)}`]
      const primitive = field.getValue(data)
      try {
        let validated = await field.runValidation(primitive)
        if (typeof hook === 'function') validated = await hook.call(this, validated)
        setValue(ret, field.sourceAttrs, validated)
      } catch (err) {
        if (err instanceof SkipField) continue
        const msgs = errorMessagesOf(err)
        if (msgs === null) throw err
        errors[field.fieldName] = msgs
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors)
    return ret
  }

  /** Object → dict of primitives (awaits relations and async `toRepresentation`s). */
  override async toRepresentation(instance: any): Promise<Record<string, any>> {
    const ret: Record<string, any> = {}
    for (const field of this.readableFields) {
      let attribute: any
      try {
        attribute = await field.getAttribute(instance)
      } catch (err) {
        if (err instanceof SkipField) continue
        throw err
      }
      const check = attribute instanceof PKOnlyObject ? attribute.pk : attribute
      ret[field.fieldName] =
        check === null || check === undefined ? null : await field.toRepresentation(attribute)
    }
    return ret
  }

  /** Object-level validation hook (DRF's `validate(attrs)`); return the (possibly modified) attrs. */
  validate(attrs: any): MaybePromise<any> {
    return attrs
  }

  override fieldSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    if (opts.ref && this._parent && opts._inline !== this) {
      const ref = opts.ref(this, opts)
      if (ref) return ref
    }
    const mode = opts.mode ?? 'output'
    const properties: Record<string, JSONSchema> = {}
    const required: string[] = []
    const fields = mode === 'input' ? this.writableFields : this.readableFields
    for (const f of fields) {
      if (mode === 'input' && f instanceof HiddenField) continue
      const schema = f.jsonSchema({ ...opts, partial: mode === 'input' ? opts.partial : undefined })
      if (mode === 'input') {
        delete schema.readOnly
      } else {
        delete schema.writeOnly
      }
      properties[f.fieldName] = schema
      const isRequired = mode === 'input' ? f.required && !opts.partial : f.required || f.readOnly
      if (isRequired) required.push(f.fieldName)
    }
    const s: JSONSchema = { type: 'object', properties }
    if (required.length) s.required = required
    if (!this._parent) {
      const name = this.constructor.name.replace(/Serializer$/, '') || this.constructor.name
      s.title = name
    }
    return s
  }

  /**
   * JSON Schema (draft 2020-12, as used by OpenAPI 3.1) of this serializer's output (`mode: 'output'`) or
   * input (`mode: 'input'`, `partial` for PATCH). Used by `generateSchema()` and by agents for tool schemas.
   */
  override jsonSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    return super.jsonSchema(opts)
  }
}

/**
 * A list of objects handled by `child` (DRF's `ListSerializer`); created by `{ many: true }`.
 */
export class ListSerializer<I = any> extends BaseSerializer<I> {
  static override defaultErrorMessages: Record<string, string> = {
    not_a_list: 'Expected a list of items but got type "{input_type}".',
    empty: 'This list may not be empty.',
    max_length: 'Ensure this field has no more than {max_length} elements.',
    min_length: 'Ensure this field has at least {min_length} elements.',
  }
  override acceptsList = true
  child: BaseSerializer
  allowEmpty: boolean
  maxLength?: number
  minLength?: number

  constructor(opts: SerializerOptions<I> & { child: BaseSerializer }) {
    const { child, ...rest } = opts
    super(rest)
    if (!child) throw new TypeError('`child` is a required argument.')
    this.child = child
    this.allowEmpty = opts.allowEmpty ?? true
    this.maxLength = opts.maxLength
    this.minLength = opts.minLength
    this.child.bind('', this)
  }

  override emptyErrors(): any {
    return []
  }

  override getInitial(): any {
    if (this.initialData !== empty) return Array.isArray(this.initialData) ? this.initialData : []
    return []
  }

  override getValue(dictionary: any): unknown {
    if (isHtmlInput(dictionary)) {
      const v = dictionary[this.fieldName]
      if (v === undefined) return empty
      return Array.isArray(v) ? v : [v]
    }
    return super.getValue(dictionary)
  }

  override async runValidation(data: unknown = empty): Promise<any> {
    const [isEmpty, value] = this.validateEmptyValues(data)
    if (isEmpty) return value
    let validated = await this.toInternalValue(value)
    try {
      await this.runValidators(validated)
      validated = await this.validate(validated)
      if (validated === undefined) throw new TypeError('.validate() should return the validated data')
    } catch (err) {
      const detail = asSerializerError(err)
      if (detail === null) throw err
      throw new ValidationError(detail)
    }
    return validated
  }

  override async toInternalValue(data: unknown): Promise<any[]> {
    const key = nonFieldErrorsKey()
    if (!Array.isArray(data)) {
      const msg = this.errorMessages.not_a_list.replace('{input_type}', typeName(data))
      throw new ValidationError({ [key]: [new ErrorDetail(msg, 'not_a_list')] }, 'not_a_list')
    }
    if (!this.allowEmpty && data.length === 0) {
      throw new ValidationError({ [key]: [new ErrorDetail(this.errorMessages.empty, 'empty')] }, 'empty')
    }
    if (this.maxLength !== undefined && data.length > this.maxLength) {
      const msg = this.errorMessages.max_length.replace('{max_length}', String(this.maxLength))
      throw new ValidationError({ [key]: [new ErrorDetail(msg, 'max_length')] }, 'max_length')
    }
    if (this.minLength !== undefined && data.length < this.minLength) {
      const msg = this.errorMessages.min_length.replace('{min_length}', String(this.minLength))
      throw new ValidationError({ [key]: [new ErrorDetail(msg, 'min_length')] }, 'min_length')
    }
    const ret: any[] = []
    const errors: ErrorDetailInput[] = []
    let failed = false
    for (const item of data) {
      try {
        ret.push(await this.child.runValidation(item))
        errors.push({})
      } catch (err) {
        const msgs = errorMessagesOf(err)
        if (msgs === null) throw err
        errors.push(msgs)
        failed = true
      }
    }
    if (failed) throw new ValidationError(errors)
    return ret
  }

  override async toRepresentation(data: any): Promise<any[]> {
    let items: any = data
    if (isManager(items)) items = await items.all()
    else if (isQuerySet(items)) items = await items
    const list = Array.isArray(items) ? items : [...(items ?? [])]
    const out: any[] = []
    for (const item of list) out.push(await this.child.toRepresentation(item))
    return out
  }

  validate(attrs: any[]): MaybePromise<any[]> {
    return attrs
  }

  override mergeExtra(extra: Record<string, unknown>): any {
    return (this.validatedData as any[]).map((attrs) => ({ ...attrs, ...extra }))
  }

  override async create(validatedData: any[]): Promise<any> {
    const out: any[] = []
    for (const attrs of validatedData) out.push(await this.child.create(attrs))
    return out
  }

  override update(_instance: any, _validatedData: any): MaybePromise<I> {
    throw new TypeError(
      'Serializers with many=True do not support multiple update by default, only multiple create. For updates it is unclear how to deal with insertions and deletions. If you need to support multiple update, use a `ListSerializer` class and override `.update()` so you can specify the behavior exactly.',
    )
  }

  override fieldSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    const s: JSONSchema = { type: 'array', items: this.child.fieldSchema(opts) }
    if (this.minLength !== undefined) s.minItems = this.minLength
    else if (!this.allowEmpty) s.minItems = 1
    if (this.maxLength !== undefined) s.maxItems = this.maxLength
    return s
  }
}

// ---------------------------------------------------------------------------------------------
// ModelSerializer
// ---------------------------------------------------------------------------------------------

export interface ModelSerializerMeta {
  /** The model class. */
  model: any
  /** Field names, or `'__all__'`. */
  fields?: readonly string[] | string
  exclude?: readonly string[]
  readOnlyFields?: readonly string[]
  /** Extra options per field: `{ password: { writeOnly: true } }`. */
  extraKwargs?: Record<string, Record<string, unknown>>
  /** Nest related objects this many levels deep (read-only), instead of primary keys. */
  depth?: number
  /** Serializer-level validators (replaces the generated unique-together validators). */
  validators?: FieldValidator[]
  listSerializerClass?: typeof ListSerializer
  /** Run the model's `fullClean()` (model `clean()`, field validators, uniqueness) before saving. */
  fullClean?: boolean
  [key: string]: unknown
}

type FieldClass = new (...args: any[]) => Field

interface BuiltField {
  cls: FieldClass
  kwargs: Record<string, any>
}

const NUMERIC_TYPES = new Set([
  'IntegerField',
  'BigIntegerField',
  'SmallIntegerField',
  'PositiveIntegerField',
  'PositiveBigIntegerField',
  'PositiveSmallIntegerField',
  'FloatField',
  'DecimalField',
  'DurationField',
])
const CHAR_TYPES = new Set([
  'CharField',
  'TextField',
  'SlugField',
  'EmailField',
  'URLField',
  'FileField',
  'ImageField',
  'GenericIPAddressField',
])

/** Internal types of an ORM field, most specific first (e.g. `['ImageField', 'FileField', 'CharField']`). */
function internalTypesOf(field: any): string[] {
  const out: string[] = []
  for (
    let c = field.constructor;
    c && c !== Object && c !== Function.prototype;
    c = Object.getPrototypeOf(c)
  ) {
    if (Object.hasOwn(c, 'internalType') && typeof c.internalType === 'string') out.push(c.internalType)
  }
  if (!out.length && field.internalType) out.push(field.internalType)
  return out
}

function instantiate(cls: FieldClass, kwargs: Record<string, any>): Field {
  const proto = (cls as any).prototype
  if (proto instanceof ChoiceField || cls === (ChoiceField as unknown)) {
    const { choices, ...rest } = kwargs
    return new cls(choices ?? [], rest)
  }
  return new cls(kwargs)
}

function detailViewName(model: any): string {
  return `${model._meta.objectName.toLowerCase()}-detail`
}

/**
 * A `Serializer` whose fields are generated from a model (DRF's `ModelSerializer`):
 *
 * ```ts
 * class PostSerializer extends ModelSerializer<Post> {
 *   static Meta = { model: Post, fields: ['id', 'title', 'author', 'tags'], readOnlyFields: ['author'] }
 *   authorName = new CharField({ source: 'author.username', readOnly: true })
 * }
 * ```
 * Foreign keys and many-to-many fields become `PrimaryKeyRelatedField`s (nested serializers with `depth`),
 * `unique` fields get a `UniqueValidator`, `uniqueTogether` a `UniqueTogetherValidator`. `create()` and
 * `update()` handle many-to-many values; nested writes need your own `create()` / `update()`.
 */
export class ModelSerializer<M = any> extends Serializer<M> {
  static override Meta?: ModelSerializerMeta
  /** ORM `internalType` → serializer field class. */
  static serializerFieldMapping: Record<string, FieldClass> = {
    AutoField: IntegerField,
    BigAutoField: IntegerField,
    SmallAutoField: IntegerField,
    IntegerField,
    BigIntegerField: IntegerField,
    SmallIntegerField: IntegerField,
    PositiveIntegerField: IntegerField,
    PositiveBigIntegerField: IntegerField,
    PositiveSmallIntegerField: IntegerField,
    FloatField,
    DecimalField,
    BooleanField,
    NullBooleanField: BooleanField,
    CharField,
    TextField: CharField,
    SlugField,
    EmailField,
    URLField,
    UUIDField,
    GenericIPAddressField: IPAddressField,
    DateField,
    DateTimeField,
    TimeField,
    DurationField,
    JSONField,
    BinaryField: ReadOnlyField,
    FileField,
    ImageField,
  }
  static serializerRelatedField: FieldClass = PrimaryKeyRelatedField
  static serializerRelatedToField: FieldClass = SlugRelatedField
  static serializerUrlField: FieldClass = HyperlinkedIdentityField
  static serializerChoiceField: FieldClass = ChoiceField

  /** The validated `Meta`. */
  get meta(): ModelSerializerMeta {
    const meta = (this.constructor as typeof ModelSerializer).Meta
    if (!meta) throw new ImproperlyConfigured(`Class ${this.constructor.name} missing "Meta" attribute`)
    if (!meta.model)
      throw new ImproperlyConfigured(`Class ${this.constructor.name} missing "Meta.model" attribute`)
    return meta
  }

  get model(): any {
    return this.meta.model
  }

  override getFields(): Record<string, Field> {
    const meta = this.meta
    const model = meta.model
    const depth = meta.depth ?? 0
    if (depth < 0 || depth > 10)
      throw new ImproperlyConfigured("'depth' may not be negative or greater than 10.")
    const declared = this.declaredFields()
    const fieldNames = this.getFieldNames(declared, model)
    const extraKwargs = this.getUniquenessExtraKwargs(fieldNames, declared, this.getExtraKwargs())
    const fields: Record<string, Field> = {}
    for (const name of fieldNames) {
      if (name in declared) {
        fields[name] = declared[name]
        continue
      }
      const extra = { ...(extraKwargs[name] ?? {}) }
      let source = (extra.source as string | undefined) ?? name
      if (source === '*') source = name
      const built = this.buildField(source, model, depth)
      const kwargs = this.includeExtraKwargs(built.kwargs, extra)
      fields[name] = instantiate(built.cls, kwargs)
    }
    return fields
  }

  /** Field names from `Meta.fields` / `Meta.exclude` (declared fields missing from `fields` are appended). */
  getFieldNames(declared: Record<string, Field>, model: any): string[] {
    const meta = this.meta
    let fields = meta.fields
    const exclude = meta.exclude
    const name = this.constructor.name
    if (fields !== undefined && fields !== '__all__' && !Array.isArray(fields)) {
      throw new ImproperlyConfigured(
        `The \`fields\` option must be a list or '__all__'. Got ${typeof fields}.`,
      )
    }
    if (exclude !== undefined && !Array.isArray(exclude)) {
      throw new ImproperlyConfigured(`The \`exclude\` option must be a list. Got ${typeof exclude}.`)
    }
    if (fields !== undefined && exclude !== undefined) {
      throw new ImproperlyConfigured(`Cannot set both 'fields' and 'exclude' options on serializer ${name}.`)
    }
    if (fields === undefined && exclude === undefined) {
      throw new ImproperlyConfigured(
        `Creating a ModelSerializer without either the 'fields' attribute or the 'exclude' attribute is disallowed. Add an explicit fields = '__all__' to the ${name} serializer.`,
      )
    }
    if (fields === '__all__') fields = undefined
    if (fields) {
      const list = [...(fields as string[])]
      for (const d of Object.keys(declared)) if (!list.includes(d)) list.push(d)
      return list
    }
    const names = this.getDefaultFieldNames(declared, model)
    for (const ex of exclude ?? []) {
      if (ex in declared) {
        throw new ImproperlyConfigured(
          `Cannot both declare the field '${ex}' and include it in the ${name} 'exclude' option. Remove the field or, if inherited from a parent serializer, disable it.`,
        )
      }
      if (!names.includes(ex)) {
        throw new ImproperlyConfigured(
          `The field '${ex}' was included on serializer ${name} in 'exclude', but does not match any model field.`,
        )
      }
      names.splice(names.indexOf(ex), 1)
    }
    return names
  }

  /** `[pk] + declared + model fields + forward relations` (DRF's default for `'__all__'`). */
  getDefaultFieldNames(declared: Record<string, Field>, model: any): string[] {
    const meta = model._meta
    const plain: string[] = []
    const relations: string[] = []
    for (const f of meta.fields) {
      if (f.primaryKey || f.hidden || f.autoCreated) continue
      if (f.isRelation) relations.push(f.name)
      else plain.push(f.name)
    }
    for (const f of meta.manyToMany) if (!f.hidden) relations.push(f.name)
    return [...new Set([meta.pk.name, ...Object.keys(declared), ...plain, ...relations])]
  }

  /** Field class + kwargs for one model attribute (DRF's `build_field`). */
  buildField(sourceName: string, model: any, depth: number): BuiltField {
    const meta = model._meta
    const forward = meta.getForwardField(sourceName === 'pk' ? meta.pk.name : sourceName)
    if (forward && !forward.isRelation) return this.buildStandardField(sourceName, forward)
    if (forward?.isRelation) {
      return depth
        ? this.buildNestedField(sourceName, forward, depth, false)
        : this.buildRelationalField(sourceName, forward, false)
    }
    const reverse = meta.getRelatedObjectByAccessor?.(sourceName) ?? meta.findField?.(sourceName)
    if (reverse?.isRelation && !reverse.concrete) {
      return depth
        ? this.buildNestedField(sourceName, reverse, depth, true)
        : this.buildRelationalField(sourceName, reverse, true)
    }
    if (sourceName in model.prototype) return this.buildPropertyField(sourceName, model)
    if (sourceName === apiSettings.URL_FIELD_NAME) return this.buildUrlField(sourceName, model)
    return this.buildUnknownField(sourceName, model)
  }

  /** Serializer field for a non-relational model field (DRF's `build_standard_field` + `get_field_kwargs`). */
  buildStandardField(_fieldName: string, modelField: any): BuiltField {
    const mapping = (this.constructor as typeof ModelSerializer).serializerFieldMapping
    const types = internalTypesOf(modelField)
    let cls: FieldClass = ModelSerializer.serializerFieldMapping.CharField
    for (const t of types) {
      if (mapping[t]) {
        cls = mapping[t]
        break
      }
    }
    const type = types[0]
    const kwargs: Record<string, any> = {}
    let validators: FieldValidator[] = [...(modelField.validators ?? [])]
    const verbose = modelField.verboseName
    if (verbose) kwargs.label = capfirst(verbose)
    if (modelField.helpText) kwargs.helpText = modelField.helpText
    if (type === 'DecimalField') {
      kwargs.maxDigits = modelField.maxDigits
      kwargs.decimalPlaces = modelField.decimalPlaces
    }
    if (type === 'TextField' && !modelField.choices) kwargs.style = { baseTemplate: 'textarea.html' }
    if (type === 'JSONField') kwargs.style = { baseTemplate: 'textarea.html' }
    if (modelField.isAutoField || modelField.editable === false) {
      kwargs.readOnly = true
      return { cls, kwargs }
    }
    if (modelField.hasDefault() || modelField.blank || modelField.null) kwargs.required = false
    if (modelField.null) kwargs.allowNull = true
    if (
      modelField.blank &&
      CHAR_TYPES.has(type) &&
      cls !== (FileField as unknown) &&
      cls !== (ImageField as unknown)
    ) {
      kwargs.allowBlank = true
    }
    if (modelField.choices?.length) {
      cls = (this.constructor as typeof ModelSerializer).serializerChoiceField
      kwargs.choices = modelField.choices
      if (modelField.blank) kwargs.allowBlank = true
    } else {
      if (NUMERIC_TYPES.has(type)) {
        const max = validators.find((v) => v instanceof MaxValueValidator) as any
        const min = validators.find((v) => v instanceof MinValueValidator) as any
        if (max) {
          kwargs.maxValue = max.limitValue
          validators = validators.filter((v) => v !== max)
        }
        if (min) {
          kwargs.minValue = min.limitValue
          validators = validators.filter((v) => v !== min)
        }
        if (type.startsWith('Positive') && kwargs.minValue === undefined) kwargs.minValue = 0
      }
    }
    if (modelField.unique) {
      validators.push(
        new UniqueValidator({
          queryset: modelField.model._defaultManager,
          message: `${capfirst(modelField.model._meta.verboseName)} with this ${capfirst(modelField.verboseName)} already exists.`,
        }),
      )
    }
    if (
      modelField.maxLength !== undefined &&
      modelField.maxLength !== null &&
      CHAR_TYPES.has(type) &&
      !modelField.choices?.length
    ) {
      kwargs.maxLength = modelField.maxLength
      validators = validators.filter((v) => !(v instanceof MaxLengthValidator))
    }
    const minLen = validators.find((v) => v instanceof MinLengthValidator) as any
    if (minLen && CHAR_TYPES.has(type)) {
      kwargs.minLength = minLen.limitValue
      validators = validators.filter((v) => v !== minLen)
    }
    if (validators.length) kwargs.validators = validators
    return { cls, kwargs }
  }

  /** Relational field for FK / M2M / reverse relations (DRF's `build_relational_field`). */
  buildRelationalField(_fieldName: string, relation: any, reverse: boolean): BuiltField {
    const ctor = this.constructor as typeof ModelSerializer
    const relatedModel = reverse ? relation.relatedModel : relation.relatedModel
    const toMany = reverse ? relation.multiple !== false && !relation.oneToOne : !!relation.manyToMany
    let cls: FieldClass = ctor.serializerRelatedField
    const kwargs: Record<string, any> = { queryset: relatedModel._defaultManager }
    if (cls.prototype instanceof HyperlinkedRelatedField || cls === (HyperlinkedRelatedField as unknown)) {
      kwargs.viewName = detailViewName(relatedModel)
    }
    if (toMany) kwargs.many = true
    if (!reverse) {
      const toField = relation.toField
      if (toField && !relation.manyToMany) {
        cls = ctor.serializerRelatedToField
        kwargs.slugField = toField
        delete kwargs.viewName
      }
      const limit = relation.limitChoicesTo
      if (limit && Object.keys(limit).length) kwargs.queryset = relatedModel._defaultManager.filter(limit)
      if (relation.manyToMany && relation.hasCustomThrough) {
        kwargs.readOnly = true
        delete kwargs.queryset
      }
      if (relation.verboseName) kwargs.label = capfirst(relation.verboseName)
      if (relation.helpText) kwargs.helpText = relation.helpText
      if (relation.editable === false) {
        kwargs.readOnly = true
        delete kwargs.queryset
      }
      if (relation.null) kwargs.allowNull = true
      if (kwargs.readOnly) return { cls, kwargs }
      if (relation.hasDefault() || relation.blank || relation.null) kwargs.required = false
      if (relation.validators?.length) kwargs.validators = [...relation.validators]
      if (relation.unique && !relation.manyToMany) {
        kwargs.validators = [
          ...(kwargs.validators ?? []),
          new UniqueValidator({
            queryset: relation.model._defaultManager,
            message: `${capfirst(relation.model._meta.verboseName)} with this ${capfirst(relation.verboseName)} already exists.`,
          }),
        ]
      }
      if (toMany && !relation.blank) kwargs.allowEmpty = false
    } else {
      // Reverse relations are read-only (writing them would reassign the other side's foreign keys).
      kwargs.readOnly = true
      delete kwargs.queryset
    }
    return { cls, kwargs }
  }

  /** Nested read-only serializer for relations when `depth > 0` (DRF's `build_nested_field`). */
  buildNestedField(_fieldName: string, relation: any, depth: number, reverse: boolean): BuiltField {
    const relatedModel = relation.relatedModel
    const Base = this.nestedSerializerBase()
    const Nested = class NestedSerializer extends Base {
      static override Meta = { model: relatedModel, depth: depth - 1, fields: '__all__' }
    }
    const toMany = reverse ? !relation.oneToOne : !!relation.manyToMany
    const kwargs: Record<string, any> = { readOnly: true }
    if (toMany) kwargs.many = true
    return { cls: Nested as unknown as FieldClass, kwargs }
  }

  nestedSerializerBase(): typeof ModelSerializer {
    return ModelSerializer
  }

  /** Model getter / method → `ReadOnlyField`. */
  buildPropertyField(_fieldName: string, _model: any): BuiltField {
    return { cls: ReadOnlyField, kwargs: {} }
  }

  /** `url` → `HyperlinkedIdentityField` to `<model>-detail`. */
  buildUrlField(_fieldName: string, model: any): BuiltField {
    return {
      cls: (this.constructor as typeof ModelSerializer).serializerUrlField,
      kwargs: { viewName: detailViewName(model) },
    }
  }

  buildUnknownField(fieldName: string, model: any): never {
    throw new ImproperlyConfigured(
      `Field name \`${fieldName}\` is not valid for model \`${model.name}\` in \`${this.constructor.name}\`.`,
    )
  }

  /** Merge `extraKwargs` into generated kwargs (DRF's `include_extra_kwargs`). */
  includeExtraKwargs(kwargs: Record<string, any>, extra: Record<string, any>): Record<string, any> {
    const out = { ...kwargs }
    const ex = { ...extra }
    if (ex.readOnly) {
      for (const k of [
        'required',
        'default',
        'allowBlank',
        'minLength',
        'maxLength',
        'minValue',
        'maxValue',
        'validators',
        'queryset',
      ]) {
        delete out[k]
      }
    }
    if (ex.default !== undefined && out.required === false) delete out.required
    if (ex.readOnly ?? out.readOnly) delete ex.required
    return { ...out, ...ex }
  }

  /** `Meta.extraKwargs` plus `Meta.readOnlyFields`. */
  getExtraKwargs(): Record<string, Record<string, any>> {
    const meta = this.meta
    const extra: Record<string, Record<string, any>> = {}
    for (const [k, v] of Object.entries(meta.extraKwargs ?? {})) extra[k] = { ...v }
    const ro = meta.readOnlyFields
    if (ro !== undefined) {
      if (!Array.isArray(ro))
        throw new ImproperlyConfigured('The `readOnlyFields` option must be a list or tuple.')
      for (const name of ro) extra[name] = { ...(extra[name] ?? {}), readOnly: true }
    }
    return extra
  }

  /** Fields in `uniqueTogether` become required (or get the model default) like DRF. */
  getUniquenessExtraKwargs(
    fieldNames: string[],
    declared: Record<string, Field>,
    extra: Record<string, Record<string, any>>,
  ): Record<string, Record<string, any>> {
    const meta = this.model._meta
    if (this.meta.validators !== undefined) return extra
    const out = { ...extra }
    const sources = new Set(
      fieldNames.filter((n) => !(n in declared)).map((n) => (extra[n]?.source as string) ?? n),
    )
    for (const together of meta.uniqueTogether ?? []) {
      if (!together.every((n: string) => sources.has(n))) continue
      for (const name of together) {
        const f = meta.getForwardField(name)
        if (!f || extra[name]?.readOnly) continue
        let def: unknown = empty
        if (f.autoNowAdd) def = new CreateOnlyDefault(() => new Date())
        else if (f.autoNow) def = () => new Date()
        else if (f.hasDefault()) def = f.options?.default
        else if (f.null) def = null
        const cur = { ...(out[name] ?? {}) }
        if (def === empty) {
          if (cur.required === undefined) cur.required = true
        } else if (cur.default === undefined) cur.default = def
        out[name] = cur
      }
    }
    return out
  }

  override getValidators(): FieldValidator[] {
    const meta = this.meta
    if (meta.validators !== undefined) return [...meta.validators, ...this.validators]
    return [...this.getUniqueTogetherValidators(), ...this.validators]
  }

  /** `UniqueTogetherValidator`s for `Meta.uniqueTogether` sets fully present in the serializer. */
  getUniqueTogetherValidators(): FieldValidator[] {
    const model = this.model
    const sourceMap = new Map<string, string[]>()
    for (const f of Object.values(this.fields)) {
      const writable = !f.readOnly || f.default !== empty
      if (!writable || !f.source || f.source === '*' || f.source.includes('.')) continue
      sourceMap.set(f.source, [...(sourceMap.get(f.source) ?? []), f.fieldName])
    }
    const out: FieldValidator[] = []
    const sets: string[][] = [...(model._meta.uniqueTogether ?? [])]
    for (const c of model._meta.constraints ?? [])
      if (c.type === 'unique' && !c.condition && c.fields?.length > 1) sets.push(c.fields)
    for (const together of sets) {
      if (!together.every((n) => sourceMap.has(n))) continue
      const names = together.map((n) => sourceMap.get(n)![0])
      out.push(new UniqueTogetherValidator({ queryset: model._defaultManager, fields: names }))
    }
    return out
  }

  /** Throw if validated data contains writable nested serializers / dotted sources (DRF's `raise_errors_on_nested_writes`). */
  assertNoNestedWrites(method: 'create' | 'update', validatedData: Record<string, unknown>): void {
    const name = this.constructor.name
    for (const f of Object.values(this.fields)) {
      if (f instanceof BaseSerializer && !f.readOnly && f.source && f.source in validatedData) {
        const v = validatedData[f.source]
        if (isPlainObject(v) || Array.isArray(v)) {
          throw new TypeError(
            `The \`.${method}()\` method does not support writable nested fields by default.\nWrite an explicit \`.${method}()\` method for serializer \`${name}\`, or set \`readOnly: true\` on nested serializer fields.`,
          )
        }
      }
      if (
        f.source?.includes('.') &&
        !f.readOnly &&
        f.sourceAttrs[0] in validatedData &&
        isPlainObject(validatedData[f.sourceAttrs[0]])
      ) {
        throw new TypeError(
          `The \`.${method}()\` method does not support writable dotted-source fields by default.\nWrite an explicit \`.${method}()\` method for serializer \`${name}\`, or set \`readOnly: true\` on dotted-source serializer fields.`,
        )
      }
    }
  }

  /** Split validated data into column values and to-many values. */
  splitManyToMany(
    validatedData: Record<string, unknown>,
  ): [Record<string, unknown>, Record<string, unknown[]>] {
    const meta = this.model._meta
    const plain: Record<string, unknown> = {}
    const many: Record<string, unknown[]> = {}
    for (const [k, v] of Object.entries(validatedData)) {
      const f = meta.getForwardField(k)
      if (f?.manyToMany) many[k] = v as unknown[]
      else if (!f && meta.getRelatedObjectByAccessor?.(k)) many[k] = v as unknown[]
      else plain[k] = v
    }
    return [plain, many]
  }

  /** Run `fullClean()` when `Meta.fullClean` is set; errors become a 400 ValidationError. */
  async fullCleanInstance(instance: any, validatedKeys: string[]): Promise<void> {
    if (!this.meta.fullClean) return
    const meta = this.model._meta
    const exclude = meta.fields.map((f: any) => f.name).filter((n: string) => !validatedKeys.includes(n))
    try {
      await instance.fullClean({ exclude })
    } catch (err) {
      if (err instanceof CoreValidationError)
        throw new ValidationError(asSerializerError(err) ?? err.messages)
      throw err
    }
  }

  /** Create the model instance (many-to-many values are set after saving). */
  override async create(validatedData: Record<string, unknown>): Promise<M> {
    this.assertNoNestedWrites('create', validatedData)
    const Model = this.model
    const [plain, many] = this.splitManyToMany(validatedData)
    const instance = new Model(plain)
    await this.fullCleanInstance(instance, Object.keys(plain))
    try {
      await instance.save()
    } catch (err) {
      if (err instanceof TypeError && /unexpected|keyword|argument/i.test(err.message)) {
        throw new TypeError(
          `Got a \`TypeError\` when calling \`${Model.name}.objects.create()\`. This may be because you have a writable field on the serializer class that is not a valid argument to \`${Model.name}.objects.create()\`. You may need to make the field read-only, or override the ${this.constructor.name}.create() method to handle this correctly.\nOriginal error: ${err.message}`,
        )
      }
      throw err
    }
    for (const [k, v] of Object.entries(many)) await instance[k].set(v)
    return instance
  }

  /** Assign validated values to the instance, save, then set many-to-many values. */
  override async update(instance: M, validatedData: Record<string, unknown>): Promise<M> {
    this.assertNoNestedWrites('update', validatedData)
    const [plain, many] = this.splitManyToMany(validatedData)
    for (const [k, v] of Object.entries(plain)) (instance as any)[k] = v
    await this.fullCleanInstance(instance, Object.keys(plain))
    await (instance as any).save()
    for (const [k, v] of Object.entries(many)) await (instance as any)[k].set(v)
    return instance
  }

  /** Related model of a relation field name (used for schema generation). */
  relatedModelFor(fieldName: string): any {
    try {
      const f =
        this.model._meta.getForwardField(fieldName) ??
        this.model._meta.getRelatedObjectByAccessor?.(fieldName)
      return f?.relatedModel
    } catch {
      return undefined
    }
  }
}

/**
 * Like `ModelSerializer`, but relations are hyperlinks and objects get a `url` field (DRF's
 * `HyperlinkedModelSerializer`). Needs URL names `<model>-detail` (routers create them).
 */
export class HyperlinkedModelSerializer<M = any> extends ModelSerializer<M> {
  static override serializerRelatedField: FieldClass = HyperlinkedRelatedField

  override getDefaultFieldNames(declared: Record<string, Field>, model: any): string[] {
    const names = super.getDefaultFieldNames(declared, model).filter((n) => n !== model._meta.pk.name)
    return [...new Set([apiSettings.URL_FIELD_NAME, ...names])]
  }

  override nestedSerializerBase(): typeof ModelSerializer {
    return HyperlinkedModelSerializer
  }
}

export { ManyRelatedField, RelatedField }

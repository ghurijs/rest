import { ValidationError as CoreValidationError, ObjectDoesNotExist } from '@ghuri/core'
import { coreValidationDetail, ErrorDetail, type ErrorDetailInput, ValidationError } from './exceptions'
import { isHtmlInput } from './parsers'
import { apiSettings } from './settings'
import {
  capfirst,
  formatMessage,
  humanize,
  isModelClass,
  isPromiseLike,
  type MaybePromise,
  typeName,
} from './utils'

/** Marker for "no value supplied" (DRF's `empty`). */
export const empty: unique symbol = Symbol.for('ghuri.rest.empty') as any
export type Empty = typeof empty

/** Thrown to leave a field out of the output / validated data. */
export class SkipField extends Error {
  constructor() {
    super('skip field')
    this.name = 'SkipField'
  }
}

/** JSON Schema fragment. */
export type JSONSchema = Record<string, any>

export interface JSONSchemaOptions {
  /** `'output'` (response body, default) or `'input'` (request body: only writable fields). */
  mode?: 'input' | 'output'
  /** Input schema with no required fields (PATCH). */
  partial?: boolean
  /** Return `{ $ref }` for nested serializers (OpenAPI components); inline when absent. */
  ref?: (serializer: any, opts: JSONSchemaOptions) => JSONSchema | undefined
  /** @internal the serializer being expanded into a component (not replaced by a `$ref`). */
  _inline?: unknown
}

/**
 * A field validator: `(value, field) => void` (throw `ValidationError`), or an object with
 * `validate(value, field)`. Async validators are awaited. ORM validators (`MaxValueValidator`…) work as-is.
 */
export type FieldValidator =
  | ((value: any, field: Field) => unknown)
  | { validate(value: any, field?: Field): unknown; [k: string]: any }

/** Base for defaults that need the field (DRF's `requires_context` defaults). */
export abstract class ContextualDefault {
  readonly requiresContext = true
  abstract call(field: Field): unknown
}

/** `default: new CurrentUserDefault()` → `request.user` (from the serializer context). */
export class CurrentUserDefault extends ContextualDefault {
  call(field: Field): unknown {
    const request = field.context.request
    if (!request) throw new TypeError('CurrentUserDefault requires the request in the serializer context.')
    return request.user
  }
  toString(): string {
    return 'CurrentUserDefault()'
  }
}

/** Use `default` only when creating (no `serializer.instance`); on updates the field is skipped. */
export class CreateOnlyDefault extends ContextualDefault {
  constructor(readonly defaultValue: unknown) {
    super()
  }
  call(field: Field): unknown {
    if (field.parent?.instance !== undefined && field.parent?.instance !== null) throw new SkipField()
    const d = this.defaultValue
    if (d instanceof ContextualDefault) return d.call(field)
    return typeof d === 'function' ? (d as () => unknown)() : d
  }
}

export interface FieldOptions {
  readOnly?: boolean
  writeOnly?: boolean
  required?: boolean
  /** Value (or function / `ContextualDefault`) used when the input omits the field. */
  default?: unknown
  /** Initial value for empty forms. */
  initial?: unknown
  /** Attribute to read / write; dotted paths (`'author.username'`) and `'*'` (the whole object). */
  source?: string
  label?: string
  helpText?: string
  style?: Record<string, unknown>
  errorMessages?: Record<string, string>
  validators?: FieldValidator[]
  allowNull?: boolean
}

class AttributeMissing extends Error {
  constructor(readonly attr: string) {
    super(`missing attribute '${attr}'`)
  }
}

function isClassLike(fn: Function): boolean {
  return isModelClass(fn) || /^class[\s{]/.test(Function.prototype.toString.call(fn))
}

/**
 * Resolve `attrs` on `instance` (DRF's `get_attribute`), awaiting related objects (`await post.author`) and
 * calling zero-argument methods. A missing link in the chain (null FK) returns null.
 */
export async function getAttribute(instance: any, attrs: string[]): Promise<any> {
  let current = instance
  for (const attr of attrs) {
    if (current === null || current === undefined) return null
    let value: any
    if (current instanceof Map) {
      if (!current.has(attr)) throw new AttributeMissing(attr)
      value = current.get(attr)
    } else if (typeof current === 'object' || typeof current === 'function') {
      if (!(attr in current)) throw new AttributeMissing(attr)
      try {
        value = current[attr]
      } catch (err) {
        if (err instanceof ObjectDoesNotExist) return null
        throw err
      }
    } else {
      throw new AttributeMissing(attr)
    }
    if (typeof value === 'function' && value.length === 0 && !isClassLike(value)) value = value.call(current)
    if (isPromiseLike(value)) {
      try {
        value = await value
      } catch (err) {
        if (err instanceof ObjectDoesNotExist) return null
        throw err
      }
    }
    current = value
  }
  return current
}

/** Set a (possibly dotted) source path in a nested dict. */
export function setValue(target: Record<string, any>, keys: string[], value: unknown): void {
  if (!keys.length) {
    Object.assign(target, value as object)
    return
  }
  let obj = target
  for (const k of keys.slice(0, -1)) {
    if (!obj[k] || typeof obj[k] !== 'object') obj[k] = {}
    obj = obj[k]
  }
  obj[keys[keys.length - 1]] = value
}

function collectErrorMessages(cls: any): Record<string, string> {
  const chain: any[] = []
  for (let c = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.unshift(c)
  const out: Record<string, string> = {}
  for (const c of chain)
    if (Object.hasOwn(c, 'defaultErrorMessages')) Object.assign(out, c.defaultErrorMessages)
  return out
}

/** Collect messages from a thrown validation error (REST or core). Returns null for other errors. */
export function errorMessagesOf(err: unknown): ErrorDetailInput | null {
  if (err instanceof ValidationError) {
    return combineDetail(err)
  }
  if (err instanceof CoreValidationError) return coreValidationDetail(err)
  return null
}

function combineDetail(err: ValidationError): ErrorDetailInput {
  const walk = (d: any, c: any): ErrorDetailInput => {
    if (Array.isArray(d)) return d.map((x, i) => walk(x, Array.isArray(c) ? c[i] : c))
    if (d && typeof d === 'object') {
      const o: Record<string, ErrorDetailInput> = {}
      for (const [k, v] of Object.entries(d)) o[k] = walk(v, c?.[k])
      return o
    }
    return new ErrorDetail(String(d), typeof c === 'string' ? c : undefined)
  }
  return walk(err.detail, err.codes)
}

/** Run one validator (function or object), awaiting async ones. */
export async function callValidator(validator: FieldValidator, value: unknown, field: Field): Promise<void> {
  if (typeof validator === 'function') await validator(value, field)
  else await validator.validate(value, field)
}

/**
 * Base serializer field (DRF's `Field`). Subclasses implement `toInternalValue(data)` (input → Python value,
 * may be async) and `toRepresentation(value)` (value → JSON-able output, may be async).
 */
export class Field<TInternal = any, TRepr = any> {
  static defaultErrorMessages: Record<string, string> = {
    required: 'This field is required.',
    null: 'This field may not be null.',
  }
  /** Value used for HTML form input when the key is missing (BooleanField: false). */
  defaultEmptyHtml: unknown = empty
  /** Accepts several values for one form key (ListField, MultipleChoiceField, many=True relations). */
  acceptsList = false

  readOnly: boolean
  writeOnly: boolean
  required: boolean
  default: unknown
  initial: unknown
  source?: string
  label?: string
  helpText?: string
  style: Record<string, unknown>
  allowNull: boolean
  allowBlank?: boolean
  validators: FieldValidator[]
  errorMessages: Record<string, string>

  /** Name in the parent serializer (set by `bind()`). */
  fieldName = ''
  sourceAttrs: string[] = []
  _parent?: any
  _options: FieldOptions

  constructor(opts: FieldOptions = {}) {
    this._options = opts
    this.readOnly = opts.readOnly ?? false
    this.writeOnly = opts.writeOnly ?? false
    this.default = opts.default !== undefined ? opts.default : empty
    this.required = opts.required ?? (this.default === empty && !this.readOnly)
    if (this.readOnly && this.writeOnly) throw new TypeError('May not set both `readOnly` and `writeOnly`.')
    if (this.readOnly && opts.required) throw new TypeError('May not set both `readOnly` and `required`.')
    if (opts.required && this.default !== empty)
      throw new TypeError('May not set both `required` and `default`.')
    this.initial = opts.initial !== undefined ? opts.initial : this.initialDefault()
    this.source = opts.source
    this.label = opts.label
    this.helpText = opts.helpText
    this.style = opts.style ?? {}
    this.allowNull = opts.allowNull ?? false
    this.validators = [...(opts.validators ?? [])]
    this.errorMessages = { ...collectErrorMessages(new.target), ...(opts.errorMessages ?? {}) }
  }

  /** Default `initial` for this field type. */
  initialDefault(): unknown {
    return null
  }

  /** Attach to a parent serializer under `fieldName`. */
  bind(fieldName: string, parent: any): void {
    this.fieldName = fieldName
    this._parent = parent
    if (this.label === undefined && fieldName) this.label = capfirst(humanize(fieldName))
    if (this.source === undefined) this.source = fieldName
    this.sourceAttrs = this.source === '*' ? [] : this.source.split('.')
  }

  get parent(): any {
    return this._parent
  }

  /** The top-level serializer. */
  get root(): any {
    let r: any = this
    while (r._parent) r = r._parent
    return r
  }

  /** Serializer context (`{ request, view, format }` in generic views). */
  get context(): Record<string, any> {
    return this.root._context ?? {}
  }

  getInitial(): unknown {
    return typeof this.initial === 'function' ? (this.initial as () => unknown)() : this.initial
  }

  /** Read this field's primitive value from the input (DRF's `get_value`). */
  getValue(dictionary: any): unknown {
    if (isHtmlInput(dictionary)) {
      if (!(this.fieldName in dictionary)) {
        if (this.root.partial) return empty
        return this.defaultEmptyHtml
      }
      let ret = dictionary[this.fieldName]
      if (Array.isArray(ret) && !this.acceptsList) ret = ret[ret.length - 1]
      if (ret === '' && this.allowNull) return this.allowBlank ? '' : null
      if (ret === '' && !this.required) return this.allowBlank ? '' : empty
      return ret
    }
    if (!dictionary || typeof dictionary !== 'object') return empty
    const v = dictionary[this.fieldName]
    return v === undefined ? empty : v
  }

  /** Read the value of this field from an instance (DRF's `get_attribute`). */
  async getAttribute(instance: any): Promise<any> {
    try {
      return await getAttribute(instance, this.sourceAttrs)
    } catch (err) {
      if (!(err instanceof AttributeMissing)) throw err
      if (this.default !== empty) return this.getDefault()
      if (this.allowNull) return null
      if (!this.required) throw new SkipField()
      const parentName = this.parent?.constructor?.name ?? 'serializer'
      const instName = instance?.constructor?.name ?? typeof instance
      throw new TypeError(
        `Got an error getting a value for field \`${this.fieldName}\` on serializer \`${parentName}\`. The serializer field might be named incorrectly and not match any attribute or key on the \`${instName}\` instance. Original error: ${err.message}`,
      )
    }
  }

  /** Default for missing input; throws SkipField when there is none (or for partial updates). */
  getDefault(): unknown {
    if (this.default === empty || this.root.partial) throw new SkipField()
    const d = this.default
    if (d instanceof ContextualDefault) return d.call(this)
    if (typeof d === 'function') return (d as () => unknown)()
    return d
  }

  /** DRF's `validate_empty_values`: `[isEmpty, value]`. */
  validateEmptyValues(data: unknown): [boolean, unknown] {
    if (this.readOnly) return [true, this.getDefault()]
    if (data === empty) {
      if (this.root.partial) throw new SkipField()
      if (this.required) this.fail('required')
      return [true, this.getDefault()]
    }
    if (data === null) {
      if (!this.allowNull) this.fail('null')
      if (this.source === '*') return [false, null]
      return [true, null]
    }
    return [false, data]
  }

  /** Validate a primitive value: empty checks, `toInternalValue`, then validators. */
  async runValidation(data: unknown = empty): Promise<TInternal> {
    const [isEmpty, value] = this.validateEmptyValues(data)
    if (isEmpty) return value as TInternal
    const internal = await this.toInternalValue(value)
    await this.runValidators(internal)
    return internal
  }

  getValidators(): FieldValidator[] {
    return this.validators
  }

  async runValidators(value: unknown): Promise<void> {
    const errors: ErrorDetailInput[] = []
    for (const validator of this.getValidators()) {
      try {
        await callValidator(validator, value, this)
      } catch (err) {
        const msgs = errorMessagesOf(err)
        if (msgs === null) throw err
        if (!Array.isArray(msgs)) throw err instanceof ValidationError ? err : new ValidationError(msgs)
        errors.push(...msgs)
      }
    }
    if (errors.length) throw new ValidationError(errors)
  }

  toInternalValue(_data: unknown): MaybePromise<TInternal> {
    throw new TypeError(
      `${this.constructor.name}.toInternalValue() must be implemented for field ${this.fieldName}.`,
    )
  }

  toRepresentation(_value: any): MaybePromise<TRepr> {
    throw new TypeError(
      `${this.constructor.name}.toRepresentation() must be implemented for field ${this.fieldName}.`,
    )
  }

  /** Throw a `ValidationError` with the message for `key` (DRF's `fail`). */
  fail(key: string, params: Record<string, unknown> = {}): never {
    const tpl = this.errorMessages[key]
    if (tpl === undefined) {
      throw new TypeError(
        `ValidationError raised by \`${this.constructor.name}\`, but error key \`${key}\` does not exist in the \`errorMessages\` dictionary.`,
      )
    }
    throw new ValidationError(new ErrorDetail(formatMessage(tpl, params), key), key)
  }

  /** JSON Schema of the value (type and constraints). */
  fieldSchema(_opts: JSONSchemaOptions = {}): JSONSchema {
    return {}
  }

  /** JSON Schema of this field incl. title, description, readOnly / writeOnly, default and nullability. */
  jsonSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    const schema: JSONSchema = { ...this.fieldSchema(opts) }
    if (this.label) schema.title = this.label
    if (this.helpText) schema.description = this.helpText
    if (this.readOnly) schema.readOnly = true
    if (this.writeOnly) schema.writeOnly = true
    if (
      this.default !== empty &&
      typeof this.default !== 'function' &&
      !(this.default instanceof ContextualDefault)
    ) {
      schema.default = this.default instanceof Date ? this.default.toISOString() : this.default
    }
    if (this.allowNull) {
      if (typeof schema.type === 'string') schema.type = [schema.type, 'null']
      else if (Array.isArray(schema.type)) {
        if (!schema.type.includes('null')) schema.type = [...schema.type, 'null']
      } else if (schema.$ref || schema.oneOf || schema.allOf) {
        const { title, description, readOnly, writeOnly, ...rest } = schema
        return {
          oneOf: [rest, { type: 'null' }],
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(readOnly ? { readOnly } : {}),
          ...(writeOnly ? { writeOnly } : {}),
        }
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(null)) schema.enum = [...schema.enum, null]
    }
    return schema
  }

  toString(): string {
    return `${this.constructor.name}(${this.fieldName})`
  }
}

// ---------------------------------------------------------------------------------------------
// Validators used by fields
// ---------------------------------------------------------------------------------------------

function limitValidator(
  code: string,
  message: string,
  check: (v: any) => boolean,
  measure?: (v: any) => number,
): FieldValidator {
  const fn = (value: any) => {
    if (!check(value))
      throw new ValidationError(new ErrorDetail(formatMessage(message, { length: measure?.(value) })), code)
  }
  Object.defineProperty(fn, 'code', { value: code })
  return fn
}

// ---------------------------------------------------------------------------------------------
// Boolean / strings
// ---------------------------------------------------------------------------------------------

const TRUE_VALUES = new Set<unknown>([
  't',
  'T',
  'y',
  'Y',
  'yes',
  'Yes',
  'YES',
  'true',
  'True',
  'TRUE',
  'on',
  'On',
  'ON',
  '1',
  1,
  true,
])
const FALSE_VALUES = new Set<unknown>([
  'f',
  'F',
  'n',
  'N',
  'no',
  'No',
  'NO',
  'false',
  'False',
  'FALSE',
  'off',
  'Off',
  'OFF',
  '0',
  0,
  false,
])
const NULL_VALUES = new Set<unknown>(['null', 'Null', 'NULL', '', null])

export class BooleanField extends Field<boolean | null, boolean | null> {
  static override defaultErrorMessages: Record<string, string> = { invalid: 'Must be a valid boolean.' }
  override defaultEmptyHtml: unknown = false

  constructor(opts: FieldOptions = {}) {
    super(opts)
    if (opts.allowNull) this.defaultEmptyHtml = null
  }

  override initialDefault(): unknown {
    return false
  }

  override toInternalValue(data: unknown): boolean | null {
    if (TRUE_VALUES.has(data)) return true
    if (FALSE_VALUES.has(data)) return false
    if (this.allowNull && NULL_VALUES.has(data)) return null
    return this.fail('invalid', { input: data })
  }

  override toRepresentation(value: unknown): boolean | null {
    if (TRUE_VALUES.has(value)) return true
    if (FALSE_VALUES.has(value)) return false
    if (this.allowNull && NULL_VALUES.has(value)) return null
    return Boolean(value)
  }

  override fieldSchema(): JSONSchema {
    return { type: 'boolean' }
  }
}

/** Deprecated DRF alias: a nullable BooleanField. */
export class NullBooleanField extends BooleanField {
  constructor(opts: FieldOptions = {}) {
    super({ ...opts, allowNull: true })
  }
}

export interface CharFieldOptions extends FieldOptions {
  allowBlank?: boolean
  trimWhitespace?: boolean
  maxLength?: number
  minLength?: number
}

export class CharField extends Field<string, string> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Not a valid string.',
    blank: 'This field may not be blank.',
    max_length: 'Ensure this field has no more than {max_length} characters.',
    min_length: 'Ensure this field has at least {min_length} characters.',
    null_characters: 'Null characters are not allowed.',
  }
  override allowBlank: boolean
  trimWhitespace: boolean
  maxLength?: number
  minLength?: number

  constructor(opts: CharFieldOptions = {}) {
    super(opts)
    this.allowBlank = opts.allowBlank ?? false
    this.trimWhitespace = opts.trimWhitespace ?? true
    this.maxLength = opts.maxLength
    this.minLength = opts.minLength
    if (this.maxLength !== undefined) {
      const max = this.maxLength
      this.validators.push(
        limitValidator(
          'max_length',
          formatMessage(this.errorMessages.max_length, { max_length: max }),
          (v) => String(v).length <= max,
        ),
      )
    }
    if (this.minLength !== undefined) {
      const min = this.minLength
      this.validators.push(
        limitValidator(
          'min_length',
          formatMessage(this.errorMessages.min_length, { min_length: min }),
          (v) => String(v).length >= min,
        ),
      )
    }
    this.validators.push(
      limitValidator(
        'null_characters',
        this.errorMessages.null_characters,
        (v) => !String(v).includes('\x00'),
      ),
    )
  }

  override initialDefault(): unknown {
    return ''
  }

  override async runValidation(data: unknown = empty): Promise<string> {
    if (data === '' || (this.trimWhitespace && typeof data === 'string' && data.trim() === '')) {
      if (!this.allowBlank) this.fail('blank')
      return ''
    }
    return super.runValidation(data)
  }

  override toInternalValue(data: unknown): string {
    if (typeof data === 'boolean' || !['string', 'number', 'bigint'].includes(typeof data))
      this.fail('invalid')
    const value = String(data)
    return this.trimWhitespace ? value.trim() : value
  }

  override toRepresentation(value: unknown): string {
    return String(value)
  }

  override fieldSchema(): JSONSchema {
    const s: JSONSchema = { type: 'string' }
    if (this.maxLength !== undefined) s.maxLength = this.maxLength
    if (this.minLength !== undefined) s.minLength = this.minLength
    else if (!this.allowBlank && !this.readOnly) s.minLength = 1
    return s
  }
}

function regexValidator(regex: RegExp, message: string, code = 'invalid'): FieldValidator {
  return (value: any) => {
    if (!regex.test(String(value))) throw new ValidationError(new ErrorDetail(message, code), code)
  }
}

const EMAIL_RE =
  /^[^\s@"<>()[\]\\,;:]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$|^[^\s@]+@\[[0-9a-fA-F:.]+\]$|^[^\s@"<>()[\]\\,;:]+@localhost$/

export class EmailField extends CharField {
  static override defaultErrorMessages: Record<string, string> = { invalid: 'Enter a valid email address.' }
  constructor(opts: CharFieldOptions = {}) {
    super(opts)
    this.validators.push(regexValidator(EMAIL_RE, this.errorMessages.invalid))
  }
  override fieldSchema(): JSONSchema {
    return { ...super.fieldSchema(), format: 'email' }
  }
}

export class RegexField extends CharField {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'This value does not match the required pattern.',
  }
  readonly regex: RegExp
  constructor(regex: RegExp | string, opts: CharFieldOptions = {}) {
    super(opts)
    this.regex = typeof regex === 'string' ? new RegExp(regex) : regex
    this.validators.push(regexValidator(this.regex, this.errorMessages.invalid))
  }
  override fieldSchema(): JSONSchema {
    return { ...super.fieldSchema(), pattern: this.regex.source }
  }
}

export class SlugField extends CharField {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Enter a valid "slug" consisting of letters, numbers, underscores or hyphens.',
    invalid_unicode: 'Enter a valid "slug" consisting of Unicode letters, numbers, underscores, or hyphens.',
  }
  allowUnicode: boolean
  constructor(opts: CharFieldOptions & { allowUnicode?: boolean } = {}) {
    super(opts)
    this.allowUnicode = opts.allowUnicode ?? false
    this.validators.push(
      this.allowUnicode
        ? regexValidator(/^[-\p{L}\p{N}_]+$/u, this.errorMessages.invalid_unicode)
        : regexValidator(/^[-a-zA-Z0-9_]+$/, this.errorMessages.invalid),
    )
  }
  override fieldSchema(): JSONSchema {
    return { ...super.fieldSchema(), pattern: this.allowUnicode ? '^[-\\p{L}\\p{N}_]+$' : '^[-a-zA-Z0-9_]+$' }
  }
}

export class URLField extends CharField {
  static override defaultErrorMessages: Record<string, string> = { invalid: 'Enter a valid URL.' }
  constructor(opts: CharFieldOptions = {}) {
    super(opts)
    this.validators.push((value: any) => {
      let ok = false
      try {
        const u = new URL(String(value))
        ok = ['http:', 'https:', 'ftp:', 'ftps:'].includes(u.protocol) && !!u.hostname
      } catch {}
      if (!ok) throw new ValidationError(new ErrorDetail(this.errorMessages.invalid, 'invalid'), 'invalid')
    })
  }
  override fieldSchema(): JSONSchema {
    return { ...super.fieldSchema(), format: 'uri' }
  }
}

export class UUIDField extends Field<string, string | number> {
  static override defaultErrorMessages: Record<string, string> = { invalid: 'Must be a valid UUID.' }
  uuidFormat: 'hex_verbose' | 'hex' | 'int' | 'urn'
  constructor(opts: FieldOptions & { format?: 'hex_verbose' | 'hex' | 'int' | 'urn' } = {}) {
    super(opts)
    this.uuidFormat = opts.format ?? 'hex_verbose'
  }
  override toInternalValue(data: unknown): string {
    let hex: string | null = null
    if (typeof data === 'string') {
      const s = data
        .trim()
        .toLowerCase()
        .replace(/^urn:uuid:/, '')
        .replace(/[{}]/g, '')
        .replace(/-/g, '')
      if (/^[0-9a-f]{32}$/.test(s)) hex = s
    } else if (
      (typeof data === 'number' && Number.isInteger(data) && data >= 0) ||
      typeof data === 'bigint'
    ) {
      hex = BigInt(data).toString(16).padStart(32, '0')
      if (hex.length > 32) hex = null
    }
    if (!hex) return this.fail('invalid', { value: data })
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  override toRepresentation(value: unknown): string | number {
    const s = String(value).toLowerCase()
    if (this.uuidFormat === 'hex') return s.replace(/-/g, '')
    if (this.uuidFormat === 'urn') return `urn:uuid:${s}`
    if (this.uuidFormat === 'int') return Number(BigInt(`0x${s.replace(/-/g, '')}`))
    return s
  }
  override fieldSchema(): JSONSchema {
    return { type: 'string', format: 'uuid' }
  }
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
function isIPv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return false
  try {
    new URL(`http://[${s}]/`)
    return true
  } catch {
    return false
  }
}

export class IPAddressField extends CharField {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Enter a valid IPv4 or IPv6 address.',
  }
  protocol: 'both' | 'ipv4' | 'ipv6'
  constructor(opts: CharFieldOptions & { protocol?: 'both' | 'ipv4' | 'ipv6' } = {}) {
    super(opts)
    this.protocol = opts.protocol ?? 'both'
  }
  override toInternalValue(data: unknown): string {
    if (typeof data !== 'string') this.fail('invalid', { value: data })
    const s = (data as string).trim()
    const ok = (this.protocol !== 'ipv6' && IPV4_RE.test(s)) || (this.protocol !== 'ipv4' && isIPv6(s))
    if (!ok) this.fail('invalid', { value: data })
    return s
  }
  override fieldSchema(): JSONSchema {
    if (this.protocol === 'ipv4') return { type: 'string', format: 'ipv4' }
    if (this.protocol === 'ipv6') return { type: 'string', format: 'ipv6' }
    return { type: 'string', anyOf: [{ format: 'ipv4' }, { format: 'ipv6' }] }
  }
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

const MAX_STRING_LENGTH = 1000

export interface NumberFieldOptions extends FieldOptions {
  maxValue?: number
  minValue?: number
}

function addRangeValidators(field: Field & { maxValue?: number | string; minValue?: number | string }): void {
  if (field.maxValue !== undefined) {
    const max = Number(field.maxValue)
    field.validators.push(
      limitValidator(
        'max_value',
        formatMessage(field.errorMessages.max_value, { max_value: field.maxValue }),
        (v) => Number(v) <= max,
      ),
    )
  }
  if (field.minValue !== undefined) {
    const min = Number(field.minValue)
    field.validators.push(
      limitValidator(
        'min_value',
        formatMessage(field.errorMessages.min_value, { min_value: field.minValue }),
        (v) => Number(v) >= min,
      ),
    )
  }
}

export class IntegerField extends Field<number, number> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'A valid integer is required.',
    max_value: 'Ensure this value is less than or equal to {max_value}.',
    min_value: 'Ensure this value is greater than or equal to {min_value}.',
    max_string_length: 'String value too large.',
  }
  maxValue?: number
  minValue?: number
  constructor(opts: NumberFieldOptions = {}) {
    super(opts)
    this.maxValue = opts.maxValue
    this.minValue = opts.minValue
    addRangeValidators(this)
  }
  override toInternalValue(data: unknown): number {
    if (typeof data === 'string' && data.length > MAX_STRING_LENGTH) this.fail('max_string_length')
    if (typeof data === 'number') {
      if (!Number.isInteger(data)) this.fail('invalid')
      return data
    }
    if (typeof data === 'bigint') return Number(data)
    if (typeof data !== 'string') return this.fail('invalid')
    const s = data.trim().replace(/\.0*\s*$/, '')
    if (!/^[+-]?\d+$/.test(s)) this.fail('invalid')
    const n = Number.parseInt(s, 10)
    if (!Number.isSafeInteger(n)) this.fail('invalid')
    return n
  }
  override toRepresentation(value: unknown): number {
    if (typeof value === 'bigint') return Number(value)
    return Math.trunc(Number(value))
  }
  override fieldSchema(): JSONSchema {
    const s: JSONSchema = { type: 'integer' }
    if (this.maxValue !== undefined) s.maximum = this.maxValue
    if (this.minValue !== undefined) s.minimum = this.minValue
    return s
  }
}

export class FloatField extends Field<number, number> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'A valid number is required.',
    max_value: 'Ensure this value is less than or equal to {max_value}.',
    min_value: 'Ensure this value is greater than or equal to {min_value}.',
    max_string_length: 'String value too large.',
    overflow: 'Integer value too large to convert to float',
  }
  maxValue?: number
  minValue?: number
  constructor(opts: NumberFieldOptions = {}) {
    super(opts)
    this.maxValue = opts.maxValue
    this.minValue = opts.minValue
    addRangeValidators(this)
  }
  override toInternalValue(data: unknown): number {
    if (typeof data === 'string' && data.length > MAX_STRING_LENGTH) this.fail('max_string_length')
    if (typeof data === 'boolean' || (typeof data !== 'number' && typeof data !== 'string'))
      this.fail('invalid')
    if (typeof data === 'string' && data.trim() === '') this.fail('invalid')
    const n = Number(data)
    if (!Number.isFinite(n)) this.fail('invalid')
    return n
  }
  override toRepresentation(value: unknown): number {
    return Number(value)
  }
  override fieldSchema(): JSONSchema {
    const s: JSONSchema = { type: 'number', format: 'double' }
    if (this.maxValue !== undefined) s.maximum = this.maxValue
    if (this.minValue !== undefined) s.minimum = this.minValue
    return s
  }
}

export interface DecimalFieldOptions extends FieldOptions {
  maxDigits?: number | null
  decimalPlaces?: number | null
  /** Output as string (default `COERCE_DECIMAL_TO_STRING`, true) or number. */
  coerceToString?: boolean
  maxValue?: number | string
  minValue?: number | string
  /** Strip trailing zeros in the output. */
  normalizeOutput?: boolean
}

/** Split a decimal string into sign / integer digits / fraction digits. */
function parseDecimal(s: string): { neg: boolean; int: string; frac: string } | null {
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s.trim())
  if (!m || (!m[2] && !m[3])) return null
  return { neg: m[1] === '-', int: m[2] ?? '', frac: m[3] ?? '' }
}

function roundDecimalString(neg: boolean, int: string, frac: string, places: number): string {
  if (frac.length <= places) {
    const f = frac.padEnd(places, '0')
    const i = int.replace(/^0+(?=\d)/, '') || '0'
    const out = places > 0 ? `${i}.${f}` : i
    return neg && /[1-9]/.test(out) ? `-${out}` : out
  }
  // round half even on the digit string
  const digits = (int || '0') + frac.slice(0, places)
  const next = Number(frac[places])
  const rest = frac.slice(places + 1)
  let roundUp =
    next > 5 || (next === 5 && (/[1-9]/.test(rest) || Number(digits[digits.length - 1]) % 2 === 1))
  const arr = digits.split('').map(Number)
  for (let i = arr.length - 1; i >= 0 && roundUp; i--) {
    arr[i] += 1
    if (arr[i] === 10) arr[i] = 0
    else roundUp = false
  }
  if (roundUp) arr.unshift(1)
  const all = arr.join('')
  const intPart = all.slice(0, all.length - places).replace(/^0+(?=\d)/, '') || '0'
  const out = places > 0 ? `${intPart}.${all.slice(all.length - places)}` : intPart
  return neg && /[1-9]/.test(out) ? `-${out}` : out
}

export class DecimalField extends Field<string, string | number> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'A valid number is required.',
    max_value: 'Ensure this value is less than or equal to {max_value}.',
    min_value: 'Ensure this value is greater than or equal to {min_value}.',
    max_digits: 'Ensure that there are no more than {max_digits} digits in total.',
    max_decimal_places: 'Ensure that there are no more than {max_decimal_places} decimal places.',
    max_whole_digits:
      'Ensure that there are no more than {max_whole_digits} digits before the decimal point.',
    max_string_length: 'String value too large.',
  }
  maxDigits: number | null
  decimalPlaces: number | null
  coerceToString?: boolean
  maxValue?: number | string
  minValue?: number | string
  normalizeOutput: boolean

  constructor(opts: DecimalFieldOptions = {}) {
    super(opts)
    this.maxDigits = opts.maxDigits ?? null
    this.decimalPlaces = opts.decimalPlaces ?? null
    this.coerceToString = opts.coerceToString
    this.maxValue = opts.maxValue
    this.minValue = opts.minValue
    this.normalizeOutput = opts.normalizeOutput ?? false
    addRangeValidators(this)
  }

  toDecimalString(data: unknown): string | null {
    if (typeof data === 'number') {
      if (!Number.isFinite(data)) return null
      const s = String(data)
      if (/e/i.test(s)) return data.toFixed(Math.min(20, this.decimalPlaces ?? 20))
      return s
    }
    if (typeof data === 'bigint') return data.toString()
    if (typeof data === 'string') return data.trim()
    return null
  }

  override toInternalValue(data: unknown): string {
    if (typeof data === 'string' && data.length > MAX_STRING_LENGTH) this.fail('max_string_length')
    const s = this.toDecimalString(data)
    const parsed = s === null ? null : parseDecimal(s)
    if (!parsed) return this.fail('invalid')
    return this.validatePrecision(parsed)
  }

  validatePrecision(p: { neg: boolean; int: string; frac: string }): string {
    const int = p.int.replace(/^0+/, '')
    const frac = p.frac
    const wholeDigits = int.length
    const decimals = frac.length
    const totalDigits = int.length + frac.length || 1
    if (this.maxDigits !== null && totalDigits > this.maxDigits)
      this.fail('max_digits', { max_digits: this.maxDigits })
    if (this.decimalPlaces !== null && decimals > this.decimalPlaces)
      this.fail('max_decimal_places', { max_decimal_places: this.decimalPlaces })
    if (
      this.maxDigits !== null &&
      this.decimalPlaces !== null &&
      wholeDigits > this.maxDigits - this.decimalPlaces
    )
      this.fail('max_whole_digits', { max_whole_digits: this.maxDigits - this.decimalPlaces })
    return this.quantize(p.neg, p.int, frac)
  }

  quantize(neg: boolean, int: string, frac: string): string {
    if (this.decimalPlaces === null) {
      const i = int.replace(/^0+(?=\d)/, '') || '0'
      const out = frac ? `${i}.${frac}` : i
      return neg && /[1-9]/.test(out) ? `-${out}` : out
    }
    return roundDecimalString(neg, int, frac, this.decimalPlaces)
  }

  override toRepresentation(value: unknown): string | number {
    const coerce = this.coerceToString ?? apiSettings.COERCE_DECIMAL_TO_STRING
    const s = this.toDecimalString(value)
    const parsed = s === null ? null : parseDecimal(s)
    if (!parsed) return coerce ? String(value) : Number(value)
    let out = this.quantize(parsed.neg, parsed.int, parsed.frac)
    if (this.normalizeOutput && out.includes('.')) out = out.replace(/\.?0+$/, '')
    return coerce ? out : Number(out)
  }

  override fieldSchema(): JSONSchema {
    const coerce =
      this.coerceToString ??
      (() => {
        try {
          return apiSettings.COERCE_DECIMAL_TO_STRING
        } catch {
          return true
        }
      })()
    const s: JSONSchema = coerce ? { type: 'string', format: 'decimal' } : { type: 'number' }
    if (coerce && this.decimalPlaces !== null) {
      const whole = this.maxDigits !== null ? `{0,${this.maxDigits - this.decimalPlaces}}` : '*'
      s.pattern = `^-?\\d${whole}(?:\\.\\d{0,${this.decimalPlaces}})?$`
    }
    if (!coerce) {
      if (this.maxValue !== undefined) s.maximum = Number(this.maxValue)
      if (this.minValue !== undefined) s.minimum = Number(this.minValue)
    }
    return s
  }
}

// ---------------------------------------------------------------------------------------------
// Date & time
// ---------------------------------------------------------------------------------------------

const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?$/

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export type DateFormat = 'iso-8601' | null | ((value: Date) => string)

export class DateTimeField extends Field<Date, string | Date> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Datetime has wrong format. Use one of these formats instead: {format}.',
    date: 'Expected a datetime but got a date.',
    make_aware: 'Invalid datetime for the timezone "{timezone}".',
    overflow: 'Datetime value out of range.',
  }
  static formatHint = 'YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z]'
  format?: DateFormat
  inputFormats?: string[]

  constructor(opts: FieldOptions & { format?: DateFormat; inputFormats?: string[] } = {}) {
    super(opts)
    this.format = opts.format
    this.inputFormats = opts.inputFormats
  }

  override toInternalValue(data: unknown): Date {
    if (data instanceof Date) {
      if (Number.isNaN(data.getTime())) this.fail('invalid', { format: DateTimeField.formatHint })
      return data
    }
    if (typeof data !== 'string') return this.fail('invalid', { format: DateTimeField.formatHint })
    const s = data.trim()
    if (ISO_DATE_RE.test(s)) this.fail('date')
    const m = ISO_DATETIME_RE.exec(s)
    if (!m || !validDate(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || +(m[6] ?? 0) > 59)
      this.fail('invalid', { format: DateTimeField.formatHint })
    let tz = m[8] ?? 'Z'
    if (/^[+-]\d{2}$/.test(tz)) tz = `${tz}:00`
    else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`
    const ms = (m[7] ?? '').slice(0, 3).padEnd(3, '0')
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}.${ms}${tz.toUpperCase()}`)
    if (Number.isNaN(d.getTime())) this.fail('overflow')
    return d
  }

  override toRepresentation(value: unknown): string | Date {
    if (value === null || value === undefined || value === '') return value as any
    const format = this.format !== undefined ? this.format : apiSettings.DATETIME_FORMAT
    let d: Date
    if (value instanceof Date) d = value
    else if (typeof value === 'string' || typeof value === 'number') d = new Date(value)
    else return value as any
    if (Number.isNaN(d.getTime())) return String(value)
    if (format === null) return d
    if (typeof format === 'function') return format(d)
    if (format !== 'iso-8601') return d.toISOString()
    return d.toISOString().replace('.000Z', 'Z')
  }

  override fieldSchema(): JSONSchema {
    return { type: 'string', format: 'date-time' }
  }
}

export class DateField extends Field<string, string> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Date has wrong format. Use one of these formats instead: {format}.',
    datetime: 'Expected a date but got a datetime.',
  }
  format?: DateFormat
  constructor(opts: FieldOptions & { format?: DateFormat; inputFormats?: string[] } = {}) {
    super(opts)
    this.format = opts.format
  }
  override toInternalValue(data: unknown): string {
    if (data instanceof Date) {
      if (Number.isNaN(data.getTime())) this.fail('invalid', { format: 'YYYY-MM-DD' })
      return data.toISOString().slice(0, 10)
    }
    if (typeof data !== 'string') return this.fail('invalid', { format: 'YYYY-MM-DD' })
    const s = data.trim()
    if (ISO_DATETIME_RE.test(s)) this.fail('datetime')
    const m = ISO_DATE_RE.exec(s)
    if (!m || !validDate(+m[1], +m[2], +m[3])) this.fail('invalid', { format: 'YYYY-MM-DD' })
    return s
  }
  override toRepresentation(value: unknown): string {
    if (value === null || value === undefined || value === '') return value as any
    const format = this.format !== undefined ? this.format : apiSettings.DATE_FORMAT
    const d = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`)
    if (format === null) return value as any
    if (typeof format === 'function') return format(d)
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value).slice(0, 10)
  }
  override fieldSchema(): JSONSchema {
    return { type: 'string', format: 'date' }
  }
}

export class TimeField extends Field<string, string> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Time has wrong format. Use one of these formats instead: {format}.',
  }
  override toInternalValue(data: unknown): string {
    if (typeof data !== 'string') return this.fail('invalid', { format: 'hh:mm[:ss[.uuuuuu]]' })
    const m = ISO_TIME_RE.exec(data.trim())
    if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) > 59)
      this.fail('invalid', { format: 'hh:mm[:ss[.uuuuuu]]' })
    return `${m![1]}:${m![2]}:${m![3] ?? '00'}${m![4] ? `.${m![4]}` : ''}`
  }
  override toRepresentation(value: unknown): string {
    if (value === null || value === undefined || value === '') return value as any
    return String(value)
  }
  override fieldSchema(): JSONSchema {
    return { type: 'string', format: 'time' }
  }
}

/** Format milliseconds as DRF's duration string `[DD ]HH:MM:SS[.uuuuuu]`. */
export function durationString(ms: number): string {
  const neg = ms < 0
  let rest = Math.abs(Math.round(ms * 1000)) // microseconds
  const micro = rest % 1_000_000
  rest = Math.floor(rest / 1_000_000)
  const days = Math.floor(rest / 86400)
  rest %= 86400
  const h = Math.floor(rest / 3600)
  const m = Math.floor((rest % 3600) / 60)
  const s = rest % 60
  let out = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  if (days) out = `${neg ? '-' : ''}${days} ${out}`
  else if (neg) out = `-${out}`
  if (micro) out += `.${String(micro).padStart(6, '0')}`
  return out
}

/** Parse DRF / ISO 8601 durations into milliseconds (null when invalid). */
export function parseDuration(value: string): number | null {
  const s = value.trim()
  const std = /^(?:(-?\d+) (?:days?, )?)?(-)?(?:(\d+):)??(?:(\d+):)?(\d+(?:[.,]\d{1,6})?)$/.exec(s)
  if (std) {
    const days = Number(std[1] ?? 0)
    const sign = std[2] ? -1 : 1
    const h = Number(std[3] ?? 0)
    const m = Number(std[4] ?? 0)
    const sec = Number((std[5] ?? '0').replace(',', '.'))
    return days * 86400000 + sign * (h * 3600000 + m * 60000 + Math.round(sec * 1000))
  }
  const iso =
    /^([-+]?)P(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i.exec(
      s,
    )
  if (iso && s.length > 1 && !/T$/i.test(s)) {
    const n = (x?: string) => Number((x ?? '0').replace(',', '.'))
    const total =
      n(iso[2]) * 86400000 + n(iso[3]) * 3600000 + n(iso[4]) * 60000 + Math.round(n(iso[5]) * 1000)
    return iso[1] === '-' ? -total : total
  }
  return null
}

/** Durations are milliseconds (the ORM's `DurationField`); input also accepts DRF / ISO 8601 strings. */
export class DurationField extends Field<number, string> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid: 'Duration has wrong format. Use one of these formats instead: {format}.',
    max_value: 'Ensure this value is less than or equal to {max_value}.',
    min_value: 'Ensure this value is greater than or equal to {min_value}.',
  }
  maxValue?: number
  minValue?: number
  constructor(opts: NumberFieldOptions = {}) {
    super(opts)
    this.maxValue = opts.maxValue
    this.minValue = opts.minValue
    addRangeValidators(this)
  }
  override toInternalValue(data: unknown): number {
    if (typeof data === 'number' && Number.isFinite(data)) return data
    const ms = typeof data === 'string' ? parseDuration(data) : null
    if (ms === null) return this.fail('invalid', { format: '[DD] [HH:[MM:]]ss[.uuuuuu]' })
    return ms
  }
  override toRepresentation(value: unknown): string {
    return durationString(Number(value))
  }
  override fieldSchema(): JSONSchema {
    return { type: 'string', format: 'duration' }
  }
}

// ---------------------------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------------------------

export type ChoicesInput =
  | ReadonlyArray<unknown>
  | ReadonlyArray<readonly [unknown, string]>
  | Record<string, string>
  | Map<unknown, string>

function normalizeChoices(choices: ChoicesInput): Array<[unknown, string]> {
  if (choices instanceof Map) return [...choices.entries()].map(([k, v]) => [k, String(v)])
  if (Array.isArray(choices)) {
    return choices.map((c) => (Array.isArray(c) ? [c[0], String(c[1])] : [c, String(c)])) as Array<
      [unknown, string]
    >
  }
  return Object.entries(choices as Record<string, string>).map(([k, v]) => [k, String(v)])
}

export interface ChoiceFieldOptions extends FieldOptions {
  allowBlank?: boolean
  htmlCutoff?: number
  htmlCutoffText?: string
}

export class ChoiceField extends Field<unknown, unknown> {
  static override defaultErrorMessages: Record<string, string> = {
    invalid_choice: '"{input}" is not a valid choice.',
  }
  override allowBlank: boolean
  htmlCutoff?: number
  htmlCutoffText?: string
  _choices: Array<[unknown, string]> = []
  choiceStringsToValues: Map<string, unknown> = new Map()

  constructor(choices: ChoicesInput, opts: ChoiceFieldOptions = {}) {
    super(opts)
    this.choices = choices
    this.allowBlank = opts.allowBlank ?? false
    this.htmlCutoff = opts.htmlCutoff
    this.htmlCutoffText = opts.htmlCutoffText
  }

  /** `[value, label]` pairs. */
  get choices(): Array<[unknown, string]> {
    return this._choices
  }
  set choices(c: ChoicesInput) {
    this._choices = normalizeChoices(c)
    this.choiceStringsToValues = new Map(this._choices.map(([k]) => [String(k), k]))
  }

  override toInternalValue(data: unknown): unknown {
    if (data === '' && this.allowBlank) return ''
    const key = String(data)
    if (!this.choiceStringsToValues.has(key)) this.fail('invalid_choice', { input: data })
    return this.choiceStringsToValues.get(key)
  }

  override toRepresentation(value: unknown): unknown {
    if (value === '' || value === null || value === undefined) return value
    const key = String(value)
    return this.choiceStringsToValues.has(key) ? this.choiceStringsToValues.get(key) : value
  }

  override fieldSchema(): JSONSchema {
    const values = this._choices.map(([k]) => k)
    if (this.allowBlank && !values.includes('')) values.push('')
    const types = [
      ...new Set(
        values.map((v) =>
          typeof v === 'number'
            ? Number.isInteger(v)
              ? 'integer'
              : 'number'
            : typeof v === 'boolean'
              ? 'boolean'
              : 'string',
        ),
      ),
    ]
    const s: JSONSchema = { enum: values }
    if (types.length === 1) s.type = types[0]
    if (this._choices.some(([k, l]) => String(k) !== l)) {
      s['x-enum-descriptions'] = this._choices.map(([, l]) => l)
    }
    return s
  }
}

export class MultipleChoiceField extends ChoiceField {
  static override defaultErrorMessages: Record<string, string> = {
    invalid_choice: '"{input}" is not a valid choice.',
    not_a_list: 'Expected a list of items but got type "{input_type}".',
    empty: 'This selection may not be empty.',
  }
  override acceptsList = true
  allowEmpty: boolean

  constructor(choices: ChoicesInput, opts: ChoiceFieldOptions & { allowEmpty?: boolean } = {}) {
    super(choices, opts)
    this.allowEmpty = opts.allowEmpty ?? true
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

  override toInternalValue(data: unknown): unknown[] {
    if (typeof data === 'string' || !Array.isArray(data))
      return this.fail('not_a_list', { input_type: typeName(data) })
    if (!this.allowEmpty && data.length === 0) this.fail('empty')
    const out: unknown[] = []
    for (const item of data) {
      const v = super.toInternalValue(item)
      if (!out.includes(v)) out.push(v)
    }
    return out
  }

  override toRepresentation(value: unknown): unknown[] {
    const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : []
    return list.map((v) => super.toRepresentation(v))
  }

  override fieldSchema(): JSONSchema {
    return { type: 'array', items: super.fieldSchema(), ...(this.allowEmpty ? {} : { minItems: 1 }) }
  }
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export interface FileFieldOptions extends FieldOptions {
  maxLength?: number
  allowEmptyFile?: boolean
  /** Output the file URL (default `UPLOADED_FILES_USE_URL`) instead of its name. */
  useUrl?: boolean
}

/** Upload field: input is a `File` (multipart); output is the stored file's URL (or name). */
export class FileField extends Field<File, string | null> {
  static override defaultErrorMessages: Record<string, string> = {
    required: 'No file was submitted.',
    invalid: 'The submitted data was not a file. Check the encoding type on the form.',
    no_name: 'No filename could be determined.',
    empty: 'The submitted file is empty.',
    max_length: 'Ensure this filename has at most {max_length} characters (it has {length}).',
  }
  maxLength?: number
  allowEmptyFile: boolean
  useUrl?: boolean

  constructor(opts: FileFieldOptions = {}) {
    super(opts)
    this.maxLength = opts.maxLength
    this.allowEmptyFile = opts.allowEmptyFile ?? false
    this.useUrl = opts.useUrl
  }

  override getValue(dictionary: any): unknown {
    const v = super.getValue(dictionary)
    if (isHtmlInput(dictionary) && v === '' && !this.required) return empty
    return v
  }

  override toInternalValue(data: unknown): File {
    if (!(data instanceof Blob)) return this.fail('invalid')
    const name = (data as File).name
    if (!name) this.fail('no_name')
    if (!this.allowEmptyFile && data.size === 0) this.fail('empty')
    if (this.maxLength !== undefined && name.length > this.maxLength)
      this.fail('max_length', { max_length: this.maxLength, length: name.length })
    return data as File
  }

  override toRepresentation(value: any): string | null {
    if (!value) return null
    const useUrl = this.useUrl ?? apiSettings.UPLOADED_FILES_USE_URL
    if (useUrl) {
      let url: unknown
      try {
        url = typeof value.url === 'function' ? value.url() : value.url
      } catch {
        url = undefined
      }
      if (typeof url === 'string' && url) {
        const request = this.context.request
        return request && typeof request.buildAbsoluteUri === 'function' ? request.buildAbsoluteUri(url) : url
      }
      if (value.name === undefined) return null
    }
    return typeof value === 'string' ? value : (value.name ?? null)
  }

  override fieldSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    if (opts.mode === 'input') return { type: 'string', format: 'binary' }
    return { type: 'string', format: 'uri' }
  }
}

export class ImageField extends FileField {
  static override defaultErrorMessages: Record<string, string> = {
    invalid_image:
      'Upload a valid image. The file you uploaded was either not an image or a corrupted image.',
  }
  override toInternalValue(data: unknown): File {
    const file = super.toInternalValue(data)
    const type = file.type || ''
    const name = file.name.toLowerCase()
    const imageExt = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|svg|heic)$/.test(name)
    if (!(type.startsWith('image/') || (!type && imageExt))) this.fail('invalid_image')
    return file
  }
}

// ---------------------------------------------------------------------------------------------
// Composite fields
// ---------------------------------------------------------------------------------------------

/** Pass-through child for ListField / DictField without a child. */
class UnvalidatedField extends Field {
  constructor(opts: FieldOptions = {}) {
    super(opts)
    this.allowBlank = true
    this.allowNull = true
  }
  override toInternalValue(data: unknown): unknown {
    return data
  }
  override toRepresentation(value: unknown): unknown {
    return value
  }
}

export interface ListFieldOptions extends FieldOptions {
  child?: Field
  allowEmpty?: boolean
  maxLength?: number
  minLength?: number
}

export class ListField extends Field<unknown[], unknown[]> {
  static override defaultErrorMessages: Record<string, string> = {
    not_a_list: 'Expected a list of items but got type "{input_type}".',
    empty: 'This list may not be empty.',
    min_length: 'Ensure this field has at least {min_length} elements.',
    max_length: 'Ensure this field has no more than {max_length} elements.',
  }
  override acceptsList = true
  child: Field
  allowEmpty: boolean
  maxLength?: number
  minLength?: number

  constructor(opts: ListFieldOptions = {}) {
    super(opts)
    this.child = opts.child ?? new UnvalidatedField()
    this.allowEmpty = opts.allowEmpty ?? true
    this.maxLength = opts.maxLength
    this.minLength = opts.minLength
    if (this.child.source !== undefined && this.child.source !== '') {
      throw new TypeError('The `source` argument is not meaningful when applied to a `child=` field.')
    }
    this.child.bind('', this)
    if (this.maxLength !== undefined) {
      const max = this.maxLength
      this.validators.push(
        limitValidator(
          'max_length',
          formatMessage(this.errorMessages.max_length, { max_length: max }),
          (v) => v.length <= max,
        ),
      )
    }
    if (this.minLength !== undefined) {
      const min = this.minLength
      this.validators.push(
        limitValidator(
          'min_length',
          formatMessage(this.errorMessages.min_length, { min_length: min }),
          (v) => v.length >= min,
        ),
      )
    }
  }

  override initialDefault(): unknown {
    return []
  }

  override getValue(dictionary: any): unknown {
    if (isHtmlInput(dictionary)) {
      if (!(this.fieldName in dictionary)) return this.root.partial ? empty : this.required ? empty : []
      const v = dictionary[this.fieldName]
      return Array.isArray(v) ? v : [v]
    }
    return super.getValue(dictionary)
  }

  override async toInternalValue(data: unknown): Promise<unknown[]> {
    if (typeof data === 'string' || !Array.isArray(data))
      return this.fail('not_a_list', { input_type: typeName(data) })
    if (!this.allowEmpty && data.length === 0) this.fail('empty')
    return this.runChildValidation(data)
  }

  async runChildValidation(data: unknown[]): Promise<unknown[]> {
    const result: unknown[] = []
    const errors: Record<number, ErrorDetailInput> = {}
    for (let i = 0; i < data.length; i++) {
      try {
        result.push(await this.child.runValidation(data[i]))
      } catch (err) {
        const msgs = errorMessagesOf(err)
        if (msgs === null) throw err
        errors[i] = msgs
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors as Record<string, ErrorDetailInput>)
    return result
  }

  override async toRepresentation(value: any): Promise<unknown[]> {
    const items = value === null || value === undefined ? [] : Array.isArray(value) ? value : [...value]
    const out: unknown[] = []
    for (const item of items)
      out.push(item === null || item === undefined ? null : await this.child.toRepresentation(item))
    return out
  }

  override fieldSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    const s: JSONSchema = {
      type: 'array',
      items: this.child instanceof UnvalidatedField ? {} : this.child.jsonSchema(opts),
    }
    if (this.minLength !== undefined) s.minItems = this.minLength
    else if (!this.allowEmpty) s.minItems = 1
    if (this.maxLength !== undefined) s.maxItems = this.maxLength
    return s
  }
}

export interface DictFieldOptions extends FieldOptions {
  child?: Field
  allowEmpty?: boolean
}

export class DictField extends Field<Record<string, unknown>, Record<string, unknown>> {
  static override defaultErrorMessages: Record<string, string> = {
    not_a_dict: 'Expected a dictionary of items but got type "{input_type}".',
    empty: 'This dictionary may not be empty.',
  }
  child: Field
  allowEmpty: boolean

  constructor(opts: DictFieldOptions = {}) {
    super(opts)
    this.child = opts.child ?? new UnvalidatedField()
    this.allowEmpty = opts.allowEmpty ?? true
    this.child.bind('', this)
  }

  override initialDefault(): unknown {
    return {}
  }

  override async toInternalValue(data: unknown): Promise<Record<string, unknown>> {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data instanceof Blob)
      return this.fail('not_a_dict', { input_type: typeName(data) })
    const entries = Object.entries(data as Record<string, unknown>)
    if (!this.allowEmpty && entries.length === 0) this.fail('empty')
    const result: Record<string, unknown> = {}
    const errors: Record<string, ErrorDetailInput> = {}
    for (const [k, v] of entries) {
      try {
        result[k] = await this.child.runValidation(v)
      } catch (err) {
        const msgs = errorMessagesOf(err)
        if (msgs === null) throw err
        errors[k] = msgs
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors)
    return result
  }

  override async toRepresentation(value: any): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {})
    for (const [k, v] of entries)
      out[String(k)] = v === null || v === undefined ? null : await this.child.toRepresentation(v)
    return out
  }

  override fieldSchema(opts: JSONSchemaOptions = {}): JSONSchema {
    return {
      type: 'object',
      additionalProperties: this.child instanceof UnvalidatedField ? {} : this.child.jsonSchema(opts),
    }
  }
}

const INVALID_JSON: unique symbol = Symbol('invalid json') as any

export class JSONField extends Field<unknown, unknown> {
  static override defaultErrorMessages: Record<string, string> = { invalid: 'Value must be valid JSON.' }
  binary: boolean
  constructor(opts: FieldOptions & { binary?: boolean } = {}) {
    super(opts)
    this.binary = opts.binary ?? false
  }

  override getValue(dictionary: any): unknown {
    const v = super.getValue(dictionary)
    if (isHtmlInput(dictionary) && typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch {
        return INVALID_JSON
      }
    }
    return v
  }

  override toInternalValue(data: unknown): unknown {
    if (data === INVALID_JSON) return this.fail('invalid')
    if (this.binary && typeof data === 'string') {
      try {
        return JSON.parse(data)
      } catch {
        return this.fail('invalid')
      }
    }
    try {
      JSON.stringify(data)
    } catch {
      this.fail('invalid')
    }
    return data
  }

  override toRepresentation(value: unknown): unknown {
    if (this.binary) return JSON.stringify(value)
    return value
  }

  override fieldSchema(): JSONSchema {
    return {}
  }
}

/** Output the attribute unchanged (DRF's `ReadOnlyField`). */
export class ReadOnlyField extends Field {
  constructor(opts: FieldOptions = {}) {
    super({ ...opts, readOnly: true })
  }
  override toRepresentation(value: unknown): unknown {
    return value
  }
}

/** A value never taken from input: always `default` (e.g. `new CurrentUserDefault()`). Not in the output. */
export class HiddenField extends Field {
  constructor(opts: FieldOptions & { default: unknown }) {
    if (opts.default === undefined) throw new TypeError('default is a required argument for HiddenField.')
    super({ ...opts, writeOnly: true })
  }
  override getValue(): unknown {
    return empty
  }
  override toInternalValue(data: unknown): unknown {
    return data
  }
}

/**
 * Read-only field computed by a serializer method: `getX(obj)` by default (`methodName` to override). The
 * method may be async.
 *
 * ```ts
 * class UserSerializer extends ModelSerializer {
 *   daysSinceJoined = new SerializerMethodField()
 *   getDaysSinceJoined(obj: User) { return (Date.now() - obj.dateJoined.getTime()) / 864e5 | 0 }
 * }
 * ```
 */
export class SerializerMethodField extends Field {
  methodName?: string
  schema?: JSONSchema
  constructor(opts: FieldOptions & { methodName?: string; schema?: JSONSchema } = {}) {
    super({ ...opts, source: '*', readOnly: true })
    this.methodName = opts.methodName
    this.schema = opts.schema
  }
  override bind(fieldName: string, parent: any): void {
    this.methodName ??= `get${capfirst(fieldName)}`
    super.bind(fieldName, parent)
  }
  override async toRepresentation(value: unknown): Promise<unknown> {
    const method = this.parent?.[this.methodName!]
    if (typeof method !== 'function') {
      throw new TypeError(
        `SerializerMethodField '${this.fieldName}' needs a method '${this.methodName}' on ${this.parent?.constructor?.name}.`,
      )
    }
    return method.call(this.parent, value)
  }
  override fieldSchema(): JSONSchema {
    return this.schema ?? {}
  }
}

/** Is `v` a serializer field instance? */
export function isField(v: unknown): v is Field {
  return v instanceof Field
}

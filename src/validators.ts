import { ErrorDetail, ValidationError } from './exceptions'
import { getAttribute } from './fields'
import { querysetFrom } from './relations'
import { formatMessage } from './utils'

function excludeCurrentInstance(qs: any, instance: any): any {
  if (instance !== undefined && instance !== null && instance.pk !== undefined && instance.pk !== null) {
    return qs.exclude({ pk: instance.pk })
  }
  return qs
}

/**
 * The field must be unique in `queryset` (DRF's `UniqueValidator`). ModelSerializer adds it for `unique`
 * model fields; the instance being updated is excluded.
 */
export class UniqueValidator {
  readonly requiresContext = true
  queryset: any
  message: string
  lookup: string

  constructor(opts: { queryset: any; message?: string; lookup?: string }) {
    this.queryset = opts.queryset
    this.message = opts.message ?? 'This field must be unique.'
    this.lookup = opts.lookup ?? 'exact'
  }

  async validate(value: unknown, field: any): Promise<void> {
    const fieldName = field.sourceAttrs[field.sourceAttrs.length - 1] ?? field.fieldName
    const instance = field.parent?.instance
    const key = this.lookup === 'exact' ? fieldName : `${fieldName}__${this.lookup}`
    let qs = querysetFrom(this.queryset).filter({ [key]: value })
    qs = excludeCurrentInstance(qs, instance)
    if (await qs.exists()) throw new ValidationError(new ErrorDetail(this.message, 'unique'), 'unique')
  }

  toString(): string {
    return `<UniqueValidator(queryset=${this.queryset?.model?.name ?? '?'})>`
  }
}

/**
 * The combination of `fields` must be unique (DRF's `UniqueTogetherValidator`), used as a serializer-level
 * validator (`Meta.validators`). ModelSerializer adds it for `Meta.uniqueTogether`.
 */
export class UniqueTogetherValidator {
  readonly requiresContext = true
  queryset: any
  fields: string[]
  message: string
  missingMessage = 'This field is required.'

  constructor(opts: { queryset: any; fields: string[]; message?: string }) {
    this.queryset = opts.queryset
    this.fields = opts.fields
    this.message = opts.message ?? 'The fields {field_names} must make a unique set.'
  }

  sourceOf(serializer: any, name: string): string {
    return serializer.fields?.[name]?.source ?? name
  }

  enforceRequiredFields(attrs: Record<string, unknown>, serializer: any): void {
    if (serializer.instance !== undefined && serializer.instance !== null) return
    const missing: Record<string, ErrorDetail[]> = {}
    for (const f of this.fields) {
      if (!(this.sourceOf(serializer, f) in attrs))
        missing[f] = [new ErrorDetail(this.missingMessage, 'required')]
    }
    if (Object.keys(missing).length) throw new ValidationError(missing, 'required')
  }

  async validate(attrs: Record<string, unknown>, serializer: any): Promise<void> {
    this.enforceRequiredFields(attrs, serializer)
    const instance = serializer.instance
    const values: Record<string, unknown> = {}
    for (const f of this.fields) {
      const source = this.sourceOf(serializer, f)
      if (source in attrs) values[source] = attrs[source]
      else if (instance) values[source] = await getAttribute(instance, [source])
    }
    if (Object.values(values).some((v) => v === null || v === undefined)) return
    let qs = querysetFrom(this.queryset).filter(values)
    qs = excludeCurrentInstance(qs, instance)
    if (await qs.exists()) {
      const msg = formatMessage(this.message, { field_names: this.fields.join(', ') })
      throw new ValidationError(new ErrorDetail(msg, 'unique'), 'unique')
    }
  }

  toString(): string {
    return `<UniqueTogetherValidator(fields=${this.fields.join(', ')})>`
  }
}

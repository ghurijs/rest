import { PermissionDenied as CorePermissionDenied, Http404 } from '@ghuri/core'
import { APIException } from './exceptions'
import { ChoiceField, empty, type Field, ListField } from './fields'
import type { APIRequest } from './request'
import { type BaseSerializer, ListSerializer, Serializer } from './serializers'

const TYPE_LOOKUP: Array<[string, string]> = [
  ['BooleanField', 'boolean'],
  ['NullBooleanField', 'boolean'],
  ['URLField', 'url'],
  ['EmailField', 'email'],
  ['RegexField', 'regex'],
  ['SlugField', 'slug'],
  ['IntegerField', 'integer'],
  ['FloatField', 'float'],
  ['DecimalField', 'decimal'],
  ['DateField', 'date'],
  ['DateTimeField', 'datetime'],
  ['TimeField', 'time'],
  ['DurationField', 'duration'],
  ['MultipleChoiceField', 'multiple choice'],
  ['ChoiceField', 'choice'],
  ['ImageField', 'image upload'],
  ['FileField', 'file upload'],
  ['ListField', 'list'],
  ['DictField', 'nested object'],
  ['JSONField', 'json'],
  ['ManyRelatedField', 'field'],
  ['UUIDField', 'string'],
  ['IPAddressField', 'string'],
  ['CharField', 'string'],
]

function fieldType(field: Field): string {
  if (field instanceof Serializer) return 'nested object'
  if (field instanceof ListSerializer) return 'list'
  for (let c: any = field.constructor; c?.name; c = Object.getPrototypeOf(c)) {
    const hit = TYPE_LOOKUP.find(([name]) => name === c.name)
    if (hit) return hit[1]
  }
  return 'field'
}

/**
 * OPTIONS responses (DRF's `SimpleMetadata`): name, description, renders / parses media types, and for
 * writable views the fields of POST / PUT with type, required, readOnly, label, limits and choices.
 */
export class SimpleMetadata {
  async determineMetadata(request: APIRequest, view: any): Promise<Record<string, unknown>> {
    const metadata: Record<string, unknown> = {
      name: view.getViewName(),
      description: view.getViewDescription(),
      renders: view.getRenderers().map((r: any) => r.mediaType),
      parses: view.getParsers().map((p: any) => p.mediaType),
    }
    if (typeof view.getSerializer === 'function') {
      const actions = await this.determineActions(request, view)
      if (Object.keys(actions).length) metadata.actions = actions
    }
    return metadata
  }

  /** Field info for the POST / PUT the user may perform. */
  async determineActions(request: APIRequest, view: any): Promise<Record<string, unknown>> {
    const actions: Record<string, unknown> = {}
    const allowed: string[] = view.allowedMethods()
    for (const method of ['PUT', 'POST'].filter((m) => allowed.includes(m))) {
      // Check permissions as if the request used `method` (DRF's `clone_request`).
      const previous = request._method
      request._method = method
      try {
        await view.checkPermissions(request)
        if (method === 'PUT' && typeof view.getObject === 'function') await view.getObject()
      } catch (err) {
        if (err instanceof APIException || err instanceof Http404 || err instanceof CorePermissionDenied)
          continue
        throw err
      } finally {
        request._method = previous
      }
      const serializer = view.getSerializer()
      actions[method] = await this.getSerializerInfo(serializer)
    }
    return actions
  }

  async getSerializerInfo(serializer: BaseSerializer): Promise<Record<string, unknown>> {
    const s: any = serializer instanceof ListSerializer ? serializer.child : serializer
    const out: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(s.fields ?? {}))
      out[name] = await this.getFieldInfo(field as Field)
    return out
  }

  async getFieldInfo(field: Field): Promise<Record<string, unknown>> {
    const info: Record<string, unknown> = { type: fieldType(field), required: field.required ?? false }
    const attrs: Array<[string, string]> = [
      ['readOnly', 'readOnly'],
      ['label', 'label'],
      ['helpText', 'helpText'],
      ['minLength', 'minLength'],
      ['maxLength', 'maxLength'],
      ['minValue', 'minValue'],
      ['maxValue', 'maxValue'],
      ['maxDigits', 'maxDigits'],
      ['decimalPlaces', 'decimalPlaces'],
    ]
    for (const [attr, key] of attrs) {
      const v = (field as any)[attr]
      if (v !== undefined && v !== null && v !== '') info[key] = v
    }
    if (field.default !== empty && typeof field.default !== 'function' && typeof field.default !== 'object')
      info.default = field.default
    if (field instanceof ListField && !(field.child.constructor.name === 'UnvalidatedField'))
      info.child = await this.getFieldInfo(field.child)
    else if (field instanceof Serializer) info.children = await this.getSerializerInfo(field)
    // Related-field choices would need a query per OPTIONS request; like DRF they are omitted.
    if (!field.readOnly && field instanceof ChoiceField) {
      info.choices = field.choices.map(([value, displayName]) => ({ value, displayName }))
    }
    return info
  }
}

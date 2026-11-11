import { ValidationError as CoreValidationError } from '@ghuri/core'
import { Q } from '@ghuri/orm'
import { ValidationError } from './exceptions'
import type { APIRequest } from './request'
import { apiSettings } from './settings'

/** Filters a queryset from request parameters (DRF's `BaseFilterBackend`). */
export abstract class BaseFilterBackend {
  abstract filterQueryset(request: APIRequest, queryset: any, view: any): any
  /** OpenAPI query parameters. */
  getSchemaOperationParameters(_view: any): Array<Record<string, unknown>> {
    return []
  }
}

export type FilterBackendClass = new () => BaseFilterBackend

/** Walk a `a__b__c` path through the model graph; true if it crosses a to-many relation. */
function crossesToMany(model: any, path: string): boolean {
  let current = model
  for (const part of path.split('__')) {
    const meta = current?._meta
    if (!meta) return false
    const field = meta.findField?.(part)
    if (!field) return false
    if (
      field.manyToMany ||
      (field.concrete === false && field.isRelation && field.multiple !== false && !field.oneToOne)
    )
      return true
    if (!field.isRelation) return false
    current = field.relatedModel
  }
  return false
}

/** Resolve the model field at the end of `a__b__c` (null for lookups/transforms or unknown names). */
function resolveField(model: any, parts: string[]): any {
  let current = model
  let field: any = null
  for (const part of parts) {
    const meta = current?._meta
    if (!meta) return null
    const f = part === 'pk' ? meta.pk : meta.findField?.(part)
    if (!f) return null
    field = f
    if (f.isRelation) current = f.relatedModel
  }
  return field
}

/**
 * `?search=foo bar` across `view.searchFields` (DRF's `SearchFilter`). Terms are AND-ed, fields OR-ed. Field
 * prefixes: `^` starts-with, `=` exact (case-insensitive), `@` full-text (mapped to `icontains`), `$` regex.
 */
export class SearchFilter extends BaseFilterBackend {
  searchTitle = 'Search'
  searchDescription = 'A search term.'
  lookupPrefixes: Record<string, string> = {
    '^': 'istartswith',
    '=': 'iexact',
    '@': 'icontains',
    $: 'iregex',
  }

  get searchParam(): string {
    return apiSettings.SEARCH_PARAM
  }

  getSearchFields(view: any, _request: APIRequest): string[] | undefined {
    return view.searchFields ?? view.constructor?.searchFields
  }

  /** Terms split on whitespace / commas; `"quoted phrases"` stay together. */
  getSearchTerms(request: APIRequest): string[] {
    const value = (request.queryParams.get(this.searchParam) ?? '').replace(/\0/g, '')
    const terms: string[] = []
    const re = /"([^"]*)"|([^\s,]+)/g
    for (const m of value.matchAll(re)) {
      const t = (m[1] ?? m[2] ?? '').trim()
      if (t) terms.push(t)
    }
    return terms
  }

  constructSearch(fieldName: string): string {
    const prefix = this.lookupPrefixes[fieldName[0]]
    if (prefix) return `${fieldName.slice(1)}__${prefix}`
    return `${fieldName}__icontains`
  }

  mustCallDistinct(queryset: any, searchFields: string[]): boolean {
    return searchFields.some((f) => crossesToMany(queryset.model, f.replace(/^[\^=@$]/, '')))
  }

  filterQueryset(request: APIRequest, queryset: any, view: any): any {
    const fields = this.getSearchFields(view, request)
    const terms = this.getSearchTerms(request)
    if (!fields?.length || !terms.length) return queryset
    const lookups = fields.map((f) => this.constructSearch(f))
    let qs = queryset
    const conditions = terms.map((term) => Q.or(...lookups.map((l) => ({ [l]: term }))))
    qs = qs.filter(Q.and(...conditions))
    if (this.mustCallDistinct(queryset, fields)) qs = qs.distinct()
    return qs
  }

  override getSchemaOperationParameters(view: any): Array<Record<string, unknown>> {
    if (!(view.searchFields ?? view.constructor?.searchFields)?.length) return []
    return [
      {
        name: this.searchParam,
        required: false,
        in: 'query',
        description: this.searchDescription,
        schema: { type: 'string' },
      },
    ]
  }
}

/**
 * `?ordering=-createdAt,title` (DRF's `OrderingFilter`). Allowed fields: `view.orderingFields` (or `'__all__'`;
 * default: the serializer's readable fields). Default ordering: `view.ordering`.
 */
export class OrderingFilter extends BaseFilterBackend {
  orderingTitle = 'Ordering'
  orderingDescription = 'Which field to use when ordering the results.'

  get orderingParam(): string {
    return apiSettings.ORDERING_PARAM
  }

  getDefaultOrdering(view: any): string[] | null {
    const ordering = view.ordering ?? view.constructor?.ordering
    if (!ordering) return null
    return typeof ordering === 'string' ? [ordering] : [...ordering]
  }

  /** Allowed `[name, label]` pairs. */
  getValidFields(queryset: any, view: any): Array<[string, string]> {
    const fields = view.orderingFields ?? view.constructor?.orderingFields
    if (fields === undefined) return this.getDefaultValidFields(queryset, view)
    if (fields === '__all__') {
      const meta = queryset.model._meta
      return [...meta.fields.map((f: any) => [f.name, f.verboseName] as [string, string]), ['pk', 'pk']]
    }
    return (fields as string[]).map((f) => [f, f])
  }

  getDefaultValidFields(_queryset: any, view: any): Array<[string, string]> {
    if (typeof view.getSerializerClass !== 'function') {
      throw new TypeError(
        `Cannot use ${this.constructor.name} on a view which does not have either a 'serializerClass', an overriding 'getSerializerClass' or 'orderingFields' attribute.`,
      )
    }
    const serializer =
      typeof view.getSerializer === 'function' ? view.getSerializer() : new (view.getSerializerClass())()
    const out: Array<[string, string]> = []
    for (const f of Object.values(serializer.fields ?? {}) as any[]) {
      if (f.writeOnly || !f.source || f.source === '*' || f.constructor?.name === 'SerializerMethodField')
        continue
      out.push([f.source.replace(/\./g, '__'), f.label ?? f.fieldName])
    }
    return out
  }

  removeInvalidFields(queryset: any, fields: string[], view: any): string[] {
    const valid = new Set(this.getValidFields(queryset, view).map(([name]) => name))
    return fields.filter((term) => valid.has(term.replace(/^-/, '')))
  }

  /** Ordering terms from the query string (validated), or the view default. */
  getOrdering(request: APIRequest, queryset: any, view: any): string[] | null {
    const params = request.queryParams.get(this.orderingParam)
    if (params) {
      const fields = params
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      const ordering = this.removeInvalidFields(queryset, fields, view)
      if (ordering.length) return ordering
    }
    return this.getDefaultOrdering(view)
  }

  filterQueryset(request: APIRequest, queryset: any, view: any): any {
    const ordering = this.getOrdering(request, queryset, view)
    if (ordering?.length) return queryset.orderBy(...ordering)
    return queryset
  }

  override getSchemaOperationParameters(_view: any): Array<Record<string, unknown>> {
    return [
      {
        name: this.orderingParam,
        required: false,
        in: 'query',
        description: this.orderingDescription,
        schema: { type: 'string' },
      },
    ]
  }
}

const NUMERIC_TRANSFORMS = new Set([
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'week_day',
  'quarter',
])
const BOOL_TRUE = new Set(['true', 'True', 'TRUE', '1', 'yes', 'on', 't'])
const BOOL_FALSE = new Set(['false', 'False', 'FALSE', '0', 'no', 'off', 'f'])

function parseBool(raw: string): boolean | null {
  if (BOOL_TRUE.has(raw)) return true
  if (BOOL_FALSE.has(raw)) return false
  return null
}

/**
 * Exact and lookup filters from query parameters (a small `django-filter` / `DjangoFilterBackend`):
 *
 * ```ts
 * filtersetFields = ['published', 'author']                                      // exact matches
 * filtersetFields = { createdAt: ['gte', 'lte'], title: ['exact', 'icontains'] } // ?createdAt__gte=2024-01-01
 * ```
 * Values are converted by the model field (`'true'` → true, dates, foreign key pks); `in` / `range` take
 * comma-separated values, `isnull` a boolean. Invalid values give a 400 `{ param: ['message'] }`.
 * Parameters that are not declared are ignored.
 */
export class FieldFilter extends BaseFilterBackend {
  getFilterFields(view: any): Record<string, string[]> {
    const spec = view.filtersetFields ?? view.constructor?.filtersetFields
    if (!spec) return {}
    if (Array.isArray(spec)) return Object.fromEntries(spec.map((f: string) => [f, ['exact']]))
    return spec
  }

  /** Allowed query parameter → [field path, lookup]. */
  getAllowedParams(view: any): Map<string, [string, string]> {
    const out = new Map<string, [string, string]>()
    for (const [field, lookups] of Object.entries(this.getFilterFields(view))) {
      for (const lookup of lookups)
        out.set(lookup === 'exact' ? field : `${field}__${lookup}`, [field, lookup])
    }
    return out
  }

  convertValue(model: any, fieldPath: string, lookup: string, raw: string): unknown {
    if (lookup === 'isnull') {
      const b = parseBool(raw)
      if (b === null) throw new CoreValidationError('Enter a valid boolean.')
      return b
    }
    if (NUMERIC_TRANSFORMS.has(lookup.split('__')[0])) {
      const n = Number(raw)
      if (!Number.isInteger(n)) throw new CoreValidationError('Enter a whole number.')
      return n
    }
    const field = resolveField(model, fieldPath.split('__'))
    const convert = (v: string): unknown => {
      if (!field) return v
      const target =
        field.isRelation && field.targetField
          ? field.targetField
          : field.isRelation
            ? field.relatedModel?._meta?.pk
            : field
      if (!target) return v
      if (target.internalType === 'BooleanField' || target.internalType === 'NullBooleanField') {
        const b = parseBool(v)
        if (b === null) throw new CoreValidationError('Enter a valid boolean.')
        return b
      }
      if (
        [
          'contains',
          'icontains',
          'startswith',
          'istartswith',
          'endswith',
          'iendswith',
          'regex',
          'iregex',
          'iexact',
        ].includes(lookup)
      ) {
        return v
      }
      if (target.internalType === 'DateTimeField' && /^\d{4}-\d{2}-\d{2}$/.test(v))
        return target.toPython(`${v}T00:00:00Z`)
      return typeof target.toPython === 'function' ? target.toPython(v) : v
    }
    if (lookup === 'in')
      return raw
        .split(',')
        .filter((x) => x !== '')
        .map(convert)
    if (lookup === 'range') {
      const parts = raw.split(',')
      if (parts.length !== 2) throw new CoreValidationError('Enter a range as two comma-separated values.')
      return parts.map(convert)
    }
    return convert(raw)
  }

  filterQueryset(request: APIRequest, queryset: any, view: any): any {
    const allowed = this.getAllowedParams(view)
    if (!allowed.size) return queryset
    const filters: Record<string, unknown> = {}
    const errors: Record<string, string[]> = {}
    for (const [param, [field, lookup]] of allowed) {
      const raw = request.queryParams.get(param)
      if (raw === null || raw === '') continue
      try {
        filters[lookup === 'exact' ? field : `${field}__${lookup}`] = this.convertValue(
          queryset.model,
          field,
          lookup,
          raw,
        )
      } catch (err) {
        if (err instanceof CoreValidationError) errors[param] = err.messages
        else errors[param] = ['Enter a valid value.']
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors)
    if (!Object.keys(filters).length) return queryset
    let qs = queryset.filter(filters)
    if (
      Object.keys(filters).some((k) =>
        crossesToMany(queryset.model, k.split('__').slice(0, -1).join('__') || k),
      )
    )
      qs = qs.distinct()
    return qs
  }

  override getSchemaOperationParameters(view: any): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    let model: any
    try {
      model = view.getQueryset?.()?.model ?? view.queryset?.model
    } catch {}
    for (const [param, [field, lookup]] of this.getAllowedParams(view)) {
      let schema: Record<string, unknown> = { type: 'string' }
      const f = model ? resolveField(model, field.split('__')) : null
      if (lookup === 'isnull') schema = { type: 'boolean' }
      else if (NUMERIC_TRANSFORMS.has(lookup)) schema = { type: 'integer' }
      else if (f && typeof f.jsonSchema === 'function') {
        try {
          const s = f.jsonSchema()
          const type = Array.isArray(s.type) ? s.type.filter((t: string) => t !== 'null') : s.type
          schema = {
            type: Array.isArray(type) && type.length === 1 ? type[0] : (type ?? 'string'),
            ...(s.format ? { format: s.format } : {}),
          }
          if (s.enum && lookup === 'exact') schema.enum = s.enum.filter((x: unknown) => x !== null)
        } catch {}
      }
      if (lookup === 'in' || lookup === 'range') schema = { type: 'array', items: schema }
      out.push({
        name: param,
        required: false,
        in: 'query',
        ...(lookup === 'in' || lookup === 'range' ? { style: 'form', explode: false } : {}),
        schema,
      })
    }
    return out
  }
}

/** Alias for DRF / django-filter users. */
export { FieldFilter as DjangoFilterBackend }

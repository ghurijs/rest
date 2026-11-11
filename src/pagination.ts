import { NotFound } from './exceptions'
import type { JSONSchema } from './fields'
import type { APIRequest } from './request'
import { APIResponse } from './response'
import { apiSettings } from './settings'
import { b64decode, b64encode, positiveInt, removeQueryParam, replaceQueryParam } from './utils'

/** Pagination style (DRF's `BasePagination`). */
export abstract class BasePagination {
  displayPageControls = false
  abstract paginateQueryset(queryset: any, request: APIRequest, view?: any): Promise<any[] | null>
  abstract getPaginatedResponse(data: unknown): APIResponse
  /** Wrap the item schema in the paginated envelope (OpenAPI). */
  getPaginatedResponseSchema(schema: JSONSchema): JSONSchema {
    return schema
  }
  /** Query parameters for OpenAPI. */
  getSchemaOperationParameters(_view?: any): Array<Record<string, unknown>> {
    return []
  }
}

export type PaginationClass = new () => BasePagination

/**
 * `?page=4` (DRF's `PageNumberPagination`). Response: `{ count, next, previous, results }`.
 * Set `pageSize` (default `PAGE_SIZE`), `pageSizeQueryParam` to let clients choose, `maxPageSize`.
 */
export class PageNumberPagination extends BasePagination {
  pageSize: number | null = apiSettingsSafe('PAGE_SIZE')
  pageQueryParam = 'page'
  pageQueryDescription = 'A page number within the paginated result set.'
  pageSizeQueryParam: string | null = null
  pageSizeQueryDescription = 'Number of results to return per page.'
  maxPageSize: number | null = null
  lastPageStrings: string[] = ['last']
  invalidPageMessage = 'Invalid page.'

  count = 0
  pageNumber = 1
  numPages = 1
  request?: APIRequest

  getPageSize(request: APIRequest): number | null {
    if (this.pageSizeQueryParam) {
      const raw = request.queryParams.get(this.pageSizeQueryParam)
      if (raw !== null) {
        try {
          return positiveInt(raw, { strict: true, cutoff: this.maxPageSize })
        } catch {
          // fall through to the default
        }
      }
    }
    return this.pageSize ?? apiSettings.PAGE_SIZE
  }

  async paginateQueryset(queryset: any, request: APIRequest): Promise<any[] | null> {
    this.request = request
    const pageSize = this.getPageSize(request)
    if (!pageSize) return null
    this.count = Array.isArray(queryset) ? queryset.length : await queryset.count()
    this.numPages = Math.max(1, Math.ceil(this.count / pageSize))
    const raw = request.queryParams.get(this.pageQueryParam) ?? '1'
    let number: number
    if (this.lastPageStrings.includes(raw)) number = this.numPages
    else {
      try {
        number = positiveInt(raw, { strict: true })
      } catch {
        throw new NotFound(this.invalidPageMessage.replace('{page_number}', raw))
      }
    }
    if (number > this.numPages) throw new NotFound(this.invalidPageMessage.replace('{page_number}', raw))
    this.pageNumber = number
    const bottom = (number - 1) * pageSize
    const top = bottom + pageSize
    const page = Array.isArray(queryset) ? queryset.slice(bottom, top) : await queryset.slice(bottom, top)
    if (this.numPages > 1) this.displayPageControls = true
    return page
  }

  get hasNext(): boolean {
    return this.pageNumber < this.numPages
  }

  get hasPrevious(): boolean {
    return this.pageNumber > 1
  }

  getNextLink(): string | null {
    if (!this.hasNext || !this.request) return null
    return replaceQueryParam(this.request.buildAbsoluteUri(), this.pageQueryParam, this.pageNumber + 1)
  }

  getPreviousLink(): string | null {
    if (!this.hasPrevious || !this.request) return null
    const url = this.request.buildAbsoluteUri()
    const prev = this.pageNumber - 1
    if (prev === 1) return removeQueryParam(url, this.pageQueryParam)
    return replaceQueryParam(url, this.pageQueryParam, prev)
  }

  getPaginatedResponse(data: unknown): APIResponse {
    return new APIResponse({
      count: this.count,
      next: this.getNextLink(),
      previous: this.getPreviousLink(),
      results: data,
    })
  }

  override getPaginatedResponseSchema(schema: JSONSchema): JSONSchema {
    return {
      type: 'object',
      required: ['count', 'results'],
      properties: {
        count: { type: 'integer', examples: [123] },
        next: {
          type: ['string', 'null'],
          format: 'uri',
          examples: [`http://api.example.org/accounts/?${this.pageQueryParam}=4`],
        },
        previous: {
          type: ['string', 'null'],
          format: 'uri',
          examples: [`http://api.example.org/accounts/?${this.pageQueryParam}=2`],
        },
        results: schema,
      },
    }
  }

  override getSchemaOperationParameters(): Array<Record<string, unknown>> {
    const params: Array<Record<string, unknown>> = [
      {
        name: this.pageQueryParam,
        required: false,
        in: 'query',
        description: this.pageQueryDescription,
        schema: { type: 'integer' },
      },
    ]
    if (this.pageSizeQueryParam) {
      params.push({
        name: this.pageSizeQueryParam,
        required: false,
        in: 'query',
        description: this.pageSizeQueryDescription,
        schema: { type: 'integer' },
      })
    }
    return params
  }
}

/**
 * `?limit=100&offset=400` (DRF's `LimitOffsetPagination`). Response: `{ count, next, previous, results }`.
 */
export class LimitOffsetPagination extends BasePagination {
  defaultLimit: number | null = apiSettingsSafe('PAGE_SIZE')
  limitQueryParam = 'limit'
  limitQueryDescription = 'Number of results to return per page.'
  offsetQueryParam = 'offset'
  offsetQueryDescription = 'The initial index from which to return the results.'
  maxLimit: number | null = null

  count = 0
  limit: number | null = null
  offset = 0
  request?: APIRequest

  getLimit(request: APIRequest): number | null {
    const raw = request.queryParams.get(this.limitQueryParam)
    if (raw !== null) {
      try {
        return positiveInt(raw, { strict: true, cutoff: this.maxLimit })
      } catch {
        // fall back to the default
      }
    }
    return this.defaultLimit ?? apiSettings.PAGE_SIZE
  }

  getOffset(request: APIRequest): number {
    try {
      return positiveInt(request.queryParams.get(this.offsetQueryParam) ?? '0')
    } catch {
      return 0
    }
  }

  async paginateQueryset(queryset: any, request: APIRequest): Promise<any[] | null> {
    this.request = request
    this.limit = this.getLimit(request)
    if (this.limit === null) return null
    this.count = Array.isArray(queryset) ? queryset.length : await queryset.count()
    this.offset = this.getOffset(request)
    if (this.count > this.limit) this.displayPageControls = true
    if (this.count === 0 || this.offset > this.count) return []
    const end = this.offset + this.limit
    return Array.isArray(queryset) ? queryset.slice(this.offset, end) : await queryset.slice(this.offset, end)
  }

  getNextLink(): string | null {
    if (!this.request || this.limit === null) return null
    if (this.offset + this.limit >= this.count) return null
    let url = this.request.buildAbsoluteUri()
    url = replaceQueryParam(url, this.limitQueryParam, this.limit)
    return replaceQueryParam(url, this.offsetQueryParam, this.offset + this.limit)
  }

  getPreviousLink(): string | null {
    if (!this.request || this.limit === null) return null
    if (this.offset <= 0) return null
    let url = this.request.buildAbsoluteUri()
    url = replaceQueryParam(url, this.limitQueryParam, this.limit)
    if (this.offset - this.limit <= 0) return removeQueryParam(url, this.offsetQueryParam)
    return replaceQueryParam(url, this.offsetQueryParam, this.offset - this.limit)
  }

  getPaginatedResponse(data: unknown): APIResponse {
    return new APIResponse({
      count: this.count,
      next: this.getNextLink(),
      previous: this.getPreviousLink(),
      results: data,
    })
  }

  override getPaginatedResponseSchema(schema: JSONSchema): JSONSchema {
    return {
      type: 'object',
      required: ['count', 'results'],
      properties: {
        count: { type: 'integer', examples: [123] },
        next: {
          type: ['string', 'null'],
          format: 'uri',
          examples: [
            `http://api.example.org/accounts/?${this.offsetQueryParam}=400&${this.limitQueryParam}=100`,
          ],
        },
        previous: {
          type: ['string', 'null'],
          format: 'uri',
          examples: [
            `http://api.example.org/accounts/?${this.offsetQueryParam}=200&${this.limitQueryParam}=100`,
          ],
        },
        results: schema,
      },
    }
  }

  override getSchemaOperationParameters(): Array<Record<string, unknown>> {
    return [
      {
        name: this.limitQueryParam,
        required: false,
        in: 'query',
        description: this.limitQueryDescription,
        schema: { type: 'integer' },
      },
      {
        name: this.offsetQueryParam,
        required: false,
        in: 'query',
        description: this.offsetQueryDescription,
        schema: { type: 'integer' },
      },
    ]
  }
}

interface Cursor {
  offset: number
  reverse: boolean
  position: string | null
}

function reverseOrdering(ordering: string[]): string[] {
  return ordering.map((o) => (o.startsWith('-') ? o.slice(1) : `-${o}`))
}

/**
 * Opaque cursor pagination over a unique, unchanging ordering (DRF's `CursorPagination`): stable under
 * concurrent inserts, no counts. Response: `{ next, previous, results }`. Default ordering `'-createdAt'`.
 */
export class CursorPagination extends BasePagination {
  cursorQueryParam = 'cursor'
  cursorQueryDescription = 'The pagination cursor value.'
  pageSize: number | null = apiSettingsSafe('PAGE_SIZE')
  invalidCursorMessage = 'Invalid cursor'
  ordering: string | string[] = '-createdAt'
  pageSizeQueryParam: string | null = null
  pageSizeQueryDescription = 'Number of results to return per page.'
  maxPageSize: number | null = null
  /** Bound on the cursor offset (protects against huge OFFSETs). */
  offsetCutoff = 1000

  baseUrl = ''
  cursor: Cursor | null = null
  page: any[] = []
  hasNext = false
  hasPrevious = false
  nextPosition: string | null = null
  previousPosition: string | null = null
  orderingList: string[] = []

  getPageSize(request: APIRequest): number | null {
    if (this.pageSizeQueryParam) {
      const raw = request.queryParams.get(this.pageSizeQueryParam)
      if (raw !== null) {
        try {
          return positiveInt(raw, { strict: true, cutoff: this.maxPageSize })
        } catch {}
      }
    }
    return this.pageSize ?? apiSettings.PAGE_SIZE
  }

  /** Ordering from an `OrderingFilter` on the view, else `this.ordering`. */
  getOrdering(request: APIRequest, queryset: any, view: any): string[] {
    const backends: any[] = view?.getFilterBackends?.() ?? view?.filterBackends ?? []
    for (const B of backends) {
      const backend = new B()
      if (typeof backend.getOrdering === 'function' && 'orderingParam' in backend) {
        const ordering = backend.getOrdering(request, queryset, view)
        if (ordering?.length) return Array.isArray(ordering) ? ordering : [ordering]
      }
    }
    const ordering = typeof this.ordering === 'string' ? [this.ordering] : [...this.ordering]
    for (const o of ordering) {
      if (o.includes('__'))
        throw new TypeError(
          `Cursor pagination does not support double underscore lookups for orderings. Orderings should be an unchanging, unique or nearly-unique field on the model, such as "-createdAt" or "pk".`,
        )
    }
    return ordering
  }

  decodeCursor(request: APIRequest): Cursor | null {
    const encoded = request.queryParams.get(this.cursorQueryParam)
    if (!encoded) return null
    try {
      const tokens = new URLSearchParams(b64decode(encoded))
      const offsetRaw = tokens.get('o') ?? '0'
      const offset = positiveInt(offsetRaw, { cutoff: this.offsetCutoff })
      const reverse = Boolean(Number.parseInt(tokens.get('r') ?? '0', 10))
      const position = tokens.has('p') ? tokens.get('p') : null
      return { offset, reverse, position }
    } catch {
      throw new NotFound(this.invalidCursorMessage)
    }
  }

  encodeCursor(cursor: Cursor): string {
    const tokens = new URLSearchParams()
    if (cursor.offset !== 0) tokens.set('o', String(cursor.offset))
    if (cursor.reverse) tokens.set('r', '1')
    if (cursor.position !== null) tokens.set('p', cursor.position)
    return replaceQueryParam(this.baseUrl, this.cursorQueryParam, b64encode(tokens.toString()))
  }

  positionFromInstance(instance: any, ordering: string[]): string {
    const name = ordering[0].replace(/^-/, '')
    const attr = instance instanceof Map ? instance.get(name) : instance?.[name]
    if (attr instanceof Date) return attr.toISOString()
    return String(attr)
  }

  async paginateQueryset(queryset: any, request: APIRequest, view?: any): Promise<any[] | null> {
    const pageSize = this.getPageSize(request)
    if (!pageSize) return null
    this.pageSize = pageSize
    this.baseUrl = request.buildAbsoluteUri()
    this.orderingList = this.getOrdering(request, queryset, view)
    this.cursor = this.decodeCursor(request)
    const {
      offset,
      reverse,
      position: currentPosition,
    } = this.cursor ?? { offset: 0, reverse: false, position: null }
    let qs = queryset.orderBy(...(reverse ? reverseOrdering(this.orderingList) : this.orderingList))
    if (currentPosition !== null) {
      const order = this.orderingList[0]
      const isReversed = order.startsWith('-')
      const attr = order.replace(/^-/, '')
      const lookup = reverse !== isReversed ? `${attr}__lt` : `${attr}__gt`
      qs = qs.filter({ [lookup]: currentPosition })
    }
    const results: any[] = await qs.slice(offset, offset + pageSize + 1)
    this.page = results.slice(0, pageSize)
    let hasFollowing = false
    let followingPosition: string | null = null
    if (results.length > this.page.length) {
      hasFollowing = true
      followingPosition = this.positionFromInstance(results[results.length - 1], this.orderingList)
    }
    if (reverse) {
      this.page.reverse()
      this.hasNext = currentPosition !== null || offset > 0
      this.hasPrevious = hasFollowing
      if (this.hasNext) this.nextPosition = currentPosition
      if (this.hasPrevious) this.previousPosition = followingPosition
    } else {
      this.hasNext = hasFollowing
      this.hasPrevious = currentPosition !== null || offset > 0
      if (this.hasNext) this.nextPosition = followingPosition
      if (this.hasPrevious) this.previousPosition = currentPosition
    }
    if (this.hasNext || this.hasPrevious) this.displayPageControls = true
    return this.page
  }

  getNextLink(): string | null {
    if (!this.hasNext) return null
    const page = this.page
    const ordering = this.orderingList
    let compare: string | null
    if (page.length && this.cursor?.reverse && this.cursor.offset)
      compare = this.positionFromInstance(page[page.length - 1], ordering)
    else compare = this.nextPosition
    let offset = 0
    let position: string | null = null
    let unique = false
    for (let i = page.length - 1; i >= 0; i--) {
      position = this.positionFromInstance(page[i], ordering)
      if (position !== compare) {
        unique = true
        break
      }
      compare = position
      offset += 1
    }
    if (page.length && !unique) {
      if (!this.hasPrevious) {
        offset = this.pageSize!
        position = null
      } else if (this.cursor?.reverse) {
        offset = 0
        position = this.previousPosition
      } else {
        offset = (this.cursor?.offset ?? 0) + this.pageSize!
        position = this.previousPosition
      }
    }
    if (!page.length) position = this.nextPosition
    return this.encodeCursor({ offset, reverse: false, position })
  }

  getPreviousLink(): string | null {
    if (!this.hasPrevious) return null
    const page = this.page
    const ordering = this.orderingList
    let compare: string | null
    if (page.length && this.cursor && !this.cursor.reverse && this.cursor.offset)
      compare = this.positionFromInstance(page[0], ordering)
    else compare = this.previousPosition
    let offset = 0
    let position: string | null = null
    let unique = false
    for (const item of page) {
      position = this.positionFromInstance(item, ordering)
      if (position !== compare) {
        unique = true
        break
      }
      compare = position
      offset += 1
    }
    if (page.length && !unique) {
      if (!this.hasNext) {
        offset = this.pageSize!
        position = null
      } else if (this.cursor?.reverse) {
        offset = (this.cursor?.offset ?? 0) + this.pageSize!
        position = this.nextPosition
      } else {
        offset = 0
        position = this.nextPosition
      }
    }
    if (!page.length) position = this.previousPosition
    return this.encodeCursor({ offset, reverse: true, position })
  }

  getPaginatedResponse(data: unknown): APIResponse {
    return new APIResponse({ next: this.getNextLink(), previous: this.getPreviousLink(), results: data })
  }

  override getPaginatedResponseSchema(schema: JSONSchema): JSONSchema {
    return {
      type: 'object',
      required: ['results'],
      properties: {
        next: {
          type: ['string', 'null'],
          format: 'uri',
          examples: ['http://api.example.org/accounts/?cursor=cD00ODY%3D"'],
        },
        previous: {
          type: ['string', 'null'],
          format: 'uri',
          examples: ['http://api.example.org/accounts/?cursor=cj0xJnA9NDg3'],
        },
        results: schema,
      },
    }
  }

  override getSchemaOperationParameters(): Array<Record<string, unknown>> {
    const params: Array<Record<string, unknown>> = [
      {
        name: this.cursorQueryParam,
        required: false,
        in: 'query',
        description: this.cursorQueryDescription,
        schema: { type: 'string' },
      },
    ]
    if (this.pageSizeQueryParam) {
      params.push({
        name: this.pageSizeQueryParam,
        required: false,
        in: 'query',
        description: this.pageSizeQueryDescription,
        schema: { type: 'integer' },
      })
    }
    return params
  }
}

/** Read a setting outside a context without throwing (class field defaults). */
function apiSettingsSafe<K extends 'PAGE_SIZE'>(key: K): number | null {
  try {
    return apiSettings[key]
  } catch {
    return null
  }
}

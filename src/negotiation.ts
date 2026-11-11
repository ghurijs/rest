import { NotAcceptable, NotFound } from './exceptions'
import type { BaseParser } from './parsers'
import type { BaseRenderer } from './renderers'
import { apiSettings } from './settings'

/** Parsed media type (DRF's `_MediaType`). */
export class MediaType {
  readonly fullType: string
  readonly mainType: string
  readonly subType: string
  readonly params: Record<string, string>

  constructor(mediaTypeStr: string) {
    const [type, ...params] = (mediaTypeStr ?? '').split(';')
    this.fullType = type.trim().toLowerCase()
    const [main, sub] = this.fullType.split('/')
    this.mainType = main ?? ''
    this.subType = sub ?? ''
    this.params = {}
    for (const p of params) {
      const [k, v] = p.split('=')
      if (k && v !== undefined) this.params[k.trim()] = v.trim().replace(/^"|"$/g, '')
    }
  }

  /** DRF's `_MediaType.match`: params of `this` must be present in `other`; wildcards match anything. */
  match(other: MediaType): boolean {
    for (const key of Object.keys(this.params)) {
      if (key !== 'q' && other.params[key] !== this.params[key]) return false
    }
    if (this.subType !== '*' && other.subType !== '*' && other.subType !== this.subType) return false
    if (this.mainType !== '*' && other.mainType !== '*' && other.mainType !== this.mainType) return false
    return true
  }

  /** 0: `*\/*`, 1: `type/*`, 2: `type/sub`, 3: `type/sub; param=…`. */
  get precedence(): number {
    if (this.mainType === '*') return 0
    if (this.subType === '*') return 1
    if (!Object.keys(this.params).some((k) => k !== 'q')) return 2
    return 3
  }
}

/** DRF's `media_type_matches(lhs, rhs)` (`lhs` is the parser / renderer type). */
export function mediaTypeMatches(lhs: string, rhs: string): boolean {
  return new MediaType(lhs).match(new MediaType(rhs))
}

/** Group media types by precedence, most specific first. */
export function orderByPrecedence(mediaTypes: string[]): string[][] {
  const buckets: string[][] = [[], [], [], []]
  for (const m of mediaTypes) buckets[3 - new MediaType(m).precedence].push(m)
  return buckets.filter((b) => b.length)
}

export interface NegotiationRequest {
  c: { req: { header(name: string): string | undefined } }
  queryParams: URLSearchParams
  contentType: string
}

/** Content negotiation (DRF's `BaseContentNegotiation`). */
export abstract class BaseContentNegotiation {
  abstract selectParser(request: NegotiationRequest, parsers: BaseParser[]): BaseParser | null
  abstract selectRenderer(
    request: NegotiationRequest,
    renderers: BaseRenderer[],
    formatSuffix?: string | null,
  ): [BaseRenderer, string]
}

export type ContentNegotiationClass = new () => BaseContentNegotiation

/** DRF's `DefaultContentNegotiation`: `?format=` / `.json` suffix first, then the `Accept` header. */
export class DefaultContentNegotiation extends BaseContentNegotiation {
  get formatQueryParam(): string | null {
    return apiSettings.URL_FORMAT_OVERRIDE
  }

  selectParser(request: NegotiationRequest, parsers: BaseParser[]): BaseParser | null {
    for (const parser of parsers) if (mediaTypeMatches(parser.mediaType, request.contentType)) return parser
    return null
  }

  selectRenderer(
    request: NegotiationRequest,
    renderers: BaseRenderer[],
    formatSuffix?: string | null,
  ): [BaseRenderer, string] {
    const param = this.formatQueryParam
    const format = formatSuffix || (param ? request.queryParams.get(param) : null)
    let candidates = renderers
    if (format) {
      candidates = this.filterRenderers(renderers, format)
    }
    const accepts = this.getAcceptList(request)
    for (const set of orderByPrecedence(accepts)) {
      for (const renderer of candidates) {
        for (const mediaType of set) {
          if (mediaTypeMatches(renderer.mediaType, mediaType)) {
            if (new MediaType(mediaType).precedence > new MediaType(renderer.mediaType).precedence) {
              return [renderer, mediaType]
            }
            return [renderer, renderer.mediaType]
          }
        }
      }
    }
    throw new NotAcceptable(null, null, candidates)
  }

  filterRenderers(renderers: BaseRenderer[], format: string): BaseRenderer[] {
    const out = renderers.filter((r) => r.format === format)
    if (!out.length) throw new NotFound()
    return out
  }

  getAcceptList(request: NegotiationRequest): string[] {
    const header = request.c.req.header('accept') || '*/*'
    return header
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
}

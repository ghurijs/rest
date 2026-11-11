import type { Renderer, RendererContext } from './renderers'

export interface APIResponseOptions {
  status?: number
  headers?: HeadersInit
  /** Override the Content-Type chosen by content negotiation. */
  contentType?: string
}

/**
 * DRF's `Response`: unrendered data plus a status. The view renders it with the renderer picked by content
 * negotiation (`JSONRenderer`, `BrowsableAPIRenderer`, …) when the handler returns.
 *
 * ```ts
 * return new APIResponse(serializerData, { status: status.HTTP_201_CREATED, headers: { Location: url } })
 * return new APIResponse({ ok: true }, 202)   // status shorthand
 * ```
 */
export class APIResponse<T = any> {
  data: T
  status: number
  headers: Headers
  contentType?: string
  /** True when the response was produced by the exception handler. */
  exception = false
  acceptedRenderer?: Renderer
  acceptedMediaType?: string
  rendererContext?: RendererContext

  constructor(data?: T, opts: APIResponseOptions | number = {}) {
    const o = typeof opts === 'number' ? { status: opts } : opts
    this.data = data as T
    this.status = o.status ?? 200
    this.headers = new Headers(o.headers)
    this.contentType = o.contentType
  }

  /** DRF's `status_code`. */
  get statusCode(): number {
    return this.status
  }
  set statusCode(v: number) {
    this.status = v
  }

  /** Render with the accepted renderer into a fetch `Response`. */
  async render(method?: string): Promise<Response> {
    const renderer = this.acceptedRenderer
    if (!renderer)
      throw new TypeError('APIResponse.acceptedRenderer is not set; it is set by APIView.finalizeResponse().')
    const mediaType = this.acceptedMediaType ?? renderer.mediaType
    const ctx: RendererContext = { ...(this.rendererContext ?? {}), response: this }
    let body: string | ArrayBuffer | Uint8Array | null = await renderer.render(this.data, mediaType, ctx)
    let contentType = this.contentType
    if (!contentType) {
      contentType = renderer.charset ? `${mediaType}; charset=${renderer.charset}` : mediaType
    }
    const headers = new Headers(this.headers)
    const noBody = this.status === 204 || this.status === 304 || (this.status >= 100 && this.status < 200)
    if (noBody || method === 'HEAD') body = null
    if (body !== null && !headers.has('content-type')) headers.set('content-type', contentType)
    if (body === '' && !noBody) body = null
    return new Response(body as BodyInit | null, { status: this.status, headers })
  }
}

/** Is `v` an APIResponse (works across duplicated module instances)? */
export function isAPIResponse(v: unknown): v is APIResponse {
  return (
    v instanceof APIResponse ||
    (!!v && typeof v === 'object' && (v as any).constructor?.name === 'APIResponse')
  )
}

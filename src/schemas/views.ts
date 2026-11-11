import {
  escapeHtml,
  NoReverseMatch,
  resolverMatch,
  reverse,
  tryGetContext,
  type UrlPatterns,
} from '@ghuri/core'
import { JSONRenderer, OpenAPIJSONRenderer, type RendererClass } from '../renderers'
import type { APIRequest } from '../request'
import { APIResponse } from '../response'
import { APIView } from '../views'
import { type GenerateSchemaOptions, generateSchema, type OpenAPIDocument } from './openapi'

const cache = new WeakMap<object, Map<string, OpenAPIDocument>>()

/**
 * Serves the OpenAPI 3.1 document as JSON (DRF's `SpectacularAPIView` / `get_schema_view`):
 *
 * ```ts
 * path('api/schema/', SchemaView.asView({ title: 'Blog API', version: '1.0.0' }), { name: 'schema' })
 * ```
 * Without `patterns` the project's `ROOT_URLCONF` is used. The document is cached per urlconf.
 */
export class SchemaView extends APIView {
  override schema = null
  override rendererClasses: RendererClass[] = [JSONRenderer, OpenAPIJSONRenderer]
  title?: string
  version?: string
  /** `description` is the API description (also the view description). */
  info?: GenerateSchemaOptions['info']
  servers?: GenerateSchemaOptions['servers']
  /** URL patterns (or a router) to document; default `ROOT_URLCONF`. */
  patterns?: UrlPatterns | { urls: UrlPatterns }
  /** Mount path of `patterns` (e.g. `'api/'` for a router included there). */
  prefix?: string
  /** Cache the generated document (default true). */
  cacheSchema = true

  getSchemaSource(): UrlPatterns | { urls: UrlPatterns } {
    const src = this.patterns ?? (tryGetContext()?.settings.ROOT_URLCONF as UrlPatterns | undefined)
    if (!src) throw new TypeError('SchemaView needs `patterns` or a ROOT_URLCONF.')
    return src
  }

  generate(): OpenAPIDocument {
    const source = this.getSchemaSource()
    const opts: GenerateSchemaOptions = {
      title: this.title,
      version: this.version,
      description: this.description,
      info: this.info,
      servers: this.servers,
      prefix: this.patterns ? this.prefix : undefined,
    }
    if (!this.cacheSchema) return generateSchema(source, opts)
    const key = JSON.stringify(opts)
    let perSource = cache.get(source)
    if (!perSource) {
      perSource = new Map()
      cache.set(source, perSource)
    }
    let doc = perSource.get(key)
    if (!doc) {
      doc = generateSchema(source, opts)
      perSource.set(key, doc)
    }
    return doc
  }

  async get(_request: APIRequest): Promise<APIResponse> {
    return new APIResponse(this.generate())
  }
}

/** Base for HTML documentation pages pointing at a schema URL. */
abstract class SchemaDocsView extends APIView {
  override schema = null
  /** Schema URL (absolute or root-relative). */
  schemaUrl?: string
  /** URL name of the `SchemaView` (reversed in the current namespace), e.g. `'schema'`. */
  urlName?: string
  title = 'API documentation'

  resolveSchemaUrl(request: APIRequest): string {
    if (this.schemaUrl) return this.schemaUrl
    if (this.urlName) {
      try {
        return reverse(this.urlName)
      } catch (err) {
        if (!(err instanceof NoReverseMatch)) throw err
        const ns = resolverMatch(request.c)?.namespace
        if (ns) return reverse(`${ns}:${this.urlName}`)
        throw err
      }
    }
    return new URL('../schema/', request.url).pathname
  }

  abstract renderPage(schemaUrl: string): string

  async get(request: APIRequest): Promise<Response> {
    const html = this.renderPage(this.resolveSchemaUrl(request))
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}

/**
 * Swagger UI loaded from a CDN: `path('api/docs/', SwaggerUIView.asView({ urlName: 'schema' }))`.
 * Override `cdn` to self-host the assets.
 */
export class SwaggerUIView extends SchemaDocsView {
  cdn = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5'

  renderPage(schemaUrl: string): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(this.title)}</title><link rel="stylesheet" href="${this.cdn}/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="${this.cdn}/swagger-ui-bundle.js" crossorigin></script>
<script>
function csrf(){const m=document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);return m?decodeURIComponent(m[1]):''}
window.ui=SwaggerUIBundle({url:${JSON.stringify(schemaUrl)},dom_id:'#swagger-ui',deepLinking:true,persistAuthorization:true,
requestInterceptor:(r)=>{r.headers['X-CSRFToken']=csrf();return r}})
</script></body></html>`
  }
}

/** Scalar API reference loaded from a CDN: `path('api/reference/', ScalarView.asView({ urlName: 'schema' }))`. */
export class ScalarView extends SchemaDocsView {
  cdn = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1'

  renderPage(schemaUrl: string): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(this.title)}</title></head><body>
<script id="api-reference" data-url="${escapeHtml(schemaUrl)}"></script>
<script src="${this.cdn}"></script></body></html>`
  }
}

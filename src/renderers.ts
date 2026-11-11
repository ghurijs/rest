import { escapeHtml, getCsrfToken, toJson } from '@ghuri/core'
import type { APIResponse } from './response'

export interface RendererContext {
  view?: any
  request?: any
  response?: APIResponse
  args?: unknown[]
  kwargs?: Record<string, unknown>
  indent?: number
  [key: string]: unknown
}

/** Turns response data into bytes for one media type (DRF's `BaseRenderer`). */
export abstract class BaseRenderer {
  abstract readonly mediaType: string
  /** Value of `?format=` / the `.json` suffix that selects this renderer. */
  abstract readonly format: string
  readonly charset: string | null = 'utf-8'
  abstract render(
    data: unknown,
    acceptedMediaType?: string,
    rendererContext?: RendererContext,
  ): string | ArrayBuffer | Uint8Array | Promise<string | ArrayBuffer | Uint8Array>
}

export type Renderer = BaseRenderer
export type RendererClass = new () => BaseRenderer

function mediaParams(mediaType: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (mediaType ?? '').split(';').slice(1)) {
    const [k, v] = part.split('=')
    if (k && v !== undefined) out[k.trim()] = v.trim()
  }
  return out
}

/** `application/json` (DRF's `JSONRenderer`). `Accept: application/json; indent=2` pretty-prints. */
export class JSONRenderer extends BaseRenderer {
  readonly mediaType: string = 'application/json'
  readonly format: string = 'json'
  override readonly charset: string | null = null

  getIndent(acceptedMediaType: string | undefined, ctx: RendererContext): number | undefined {
    const indent = mediaParams(acceptedMediaType).indent
    if (indent !== undefined) {
      const n = Number.parseInt(indent, 10)
      return Number.isFinite(n) ? Math.max(0, Math.min(n, 8)) : undefined
    }
    return ctx.indent
  }

  render(data: unknown, acceptedMediaType?: string, rendererContext: RendererContext = {}): string {
    if (data === undefined || data === null) return ''
    return toJson(data, this.getIndent(acceptedMediaType, rendererContext))
  }
}

/** OpenAPI documents as JSON (`application/vnd.oai.openapi+json`). */
export class OpenAPIJSONRenderer extends JSONRenderer {
  override readonly mediaType: string = 'application/vnd.oai.openapi+json'
  override readonly format: string = 'openapi-json'
}

/** Renders a pre-rendered HTML string (DRF's `StaticHTMLRenderer`). */
export class StaticHTMLRenderer extends BaseRenderer {
  readonly mediaType: string = 'text/html'
  readonly format: string = 'html'
  render(data: unknown): string {
    return data === undefined || data === null ? '' : String(data)
  }
}

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--panel:#f6f8fa;--accent:#0b6e4f;--danger:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#30363d;--panel:#161b22;--accent:#3fb950;--danger:#f0883e}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
header strong{font-size:15px}header span{color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:16px 24px 48px}h1{font-size:24px;margin:8px 0}
.desc{color:var(--muted);margin:0 0 12px}.req{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;margin:12px 0 4px}
.req b{color:var(--accent)}pre{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px;overflow:auto;
font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
pre a{color:var(--accent)}.hdr{color:var(--muted)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
button,select{font:inherit;border:1px solid var(--border);background:var(--panel);color:var(--fg);border-radius:6px;padding:5px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}
textarea{width:100%;min-height:160px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--fg);
border:1px solid var(--border);border-radius:6px;padding:8px}form{border:1px solid var(--border);border-radius:6px;padding:12px;margin:16px 0}
label{display:block;color:var(--muted);margin-bottom:6px}`

const SCRIPT = `
function csrf(){const m=document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);return m?decodeURIComponent(m[1]):''}
async function send(method,body,type){const h={'Accept':'text/html','X-CSRFToken':csrf()};if(body!==undefined)h['Content-Type']=type;
const r=await fetch(location.href,{method,headers:h,body,credentials:'same-origin'});const t=await r.text();
if((r.headers.get('content-type')||'').includes('text/html')){document.open();document.write(t);document.close()}else{alert(r.status+' '+t)}}
document.querySelectorAll('[data-method]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();
const m=b.dataset.method;if(m==='DELETE'&&!confirm('Delete this resource?'))return;
if(m==='DELETE'||m==='OPTIONS')return send(m);const f=b.closest('form');send(m,f.content.value,f.mediaType.value)}))`

function linkify(json: string): string {
  return escapeHtml(json).replace(
    /&quot;(https?:\/\/[^&\s]+?)&quot;/g,
    (_m, url: string) => `&quot;<a href="${url}" rel="nofollow">${url}</a>&quot;`,
  )
}

/**
 * Lightweight browsable API (DRF's `BrowsableAPIRenderer`): pretty JSON with clickable links, the allowed
 * methods, and a raw-data form for POST / PUT / PATCH / DELETE. Served to browsers (`Accept: text/html`).
 */
export class BrowsableAPIRenderer extends BaseRenderer {
  readonly mediaType: string = 'text/html'
  readonly format: string = 'api'

  render(data: unknown, _acceptedMediaType?: string, ctx: RendererContext = {}): string {
    const view = ctx.view
    const request = ctx.request
    const response = ctx.response
    const status = response?.status ?? 200
    const name = typeof view?.getViewName === 'function' ? view.getViewName() : 'API'
    const description = typeof view?.getViewDescription === 'function' ? view.getViewDescription() : ''
    const allowed: string[] = typeof view?.allowedMethods === 'function' ? view.allowedMethods() : ['GET']
    const method = request?.method ?? 'GET'
    const url: string = request?.c?.req?.url ?? ''
    const path = url ? new URL(url).pathname + new URL(url).search : ''
    const headers: string[] = [`HTTP ${status}`]
    if (allowed.length) headers.push(`Allow: ${allowed.join(', ')}`)
    headers.push('Content-Type: application/json', 'Vary: Accept')
    const body = data === undefined || data === null ? '' : toJson(data, 4)
    let csrfToken = ''
    try {
      if (request?.c) csrfToken = getCsrfToken(request.c)
    } catch {}
    const forms: string[] = []
    const writeMethods = ['POST', 'PUT', 'PATCH'].filter((m) => allowed.includes(m))
    if (writeMethods.length) {
      const initial = method !== 'GET' || !['PUT', 'PATCH'].includes(writeMethods[0]) ? '' : body
      forms.push(`<form><label for="content">Content</label>
<select name="mediaType"><option>application/json</option><option>application/x-www-form-urlencoded</option></select>
<textarea name="content" id="content">${escapeHtml(initial)}</textarea>
<div class="actions">${writeMethods.map((m) => `<button class="primary" data-method="${m}">${m}</button>`).join('')}</div></form>`)
    }
    const extra = [
      allowed.includes('OPTIONS') ? '<button data-method="OPTIONS">OPTIONS</button>' : '',
      allowed.includes('DELETE') ? '<button class="danger" data-method="DELETE">DELETE</button>' : '',
    ].join('')
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="csrf-token" content="${escapeHtml(csrfToken)}">
<title>${escapeHtml(name)} – Ghuri REST framework</title><style>${CSS}</style></head><body>
<header><strong>Ghuri REST framework</strong><span>browsable API</span></header><main>
<h1>${escapeHtml(name)}</h1>${description ? `<p class="desc">${escapeHtml(description)}</p>` : ''}
<div class="actions">${extra}</div>
<div class="req"><b>${escapeHtml(method)}</b> ${escapeHtml(path)}</div>
<pre><span class="hdr">${escapeHtml(headers.join('\n'))}</span>\n\n${linkify(body)}</pre>
${forms.join('')}</main><script>${SCRIPT}</script></body></html>`
  }
}

/** Renders HTML documentation pages (Swagger UI / Scalar). */
export class DocumentationRenderer extends StaticHTMLRenderer {}

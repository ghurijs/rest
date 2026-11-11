import type { Context } from 'hono'
import { ParseError } from './exceptions'

const HTML_INPUTS = new WeakSet<object>()

/** Mark a parsed form body: fields treat missing keys / repeated keys the way DRF treats `QueryDict`s. */
export function markHtmlInput<T extends object>(data: T): T {
  HTML_INPUTS.add(data)
  return data
}

/** Is `data` a parsed HTML form (urlencoded / multipart) rather than JSON? */
export function isHtmlInput(data: unknown): boolean {
  return !!data && typeof data === 'object' && HTML_INPUTS.has(data)
}

export interface ParserContext {
  view?: unknown
  kwargs?: Record<string, unknown>
  [key: string]: unknown
}

export interface ParseResult {
  data: any
  files: Record<string, File | File[]>
}

/** Parses the request body for one media type (DRF's `BaseParser`). */
export abstract class BaseParser {
  abstract readonly mediaType: string
  abstract parse(c: Context, mediaType: string, parserContext: ParserContext): Promise<ParseResult>
}

export type ParserClass = new () => BaseParser

/** `application/json`. Invalid JSON raises `ParseError` (400). */
export class JSONParser extends BaseParser {
  readonly mediaType: string = 'application/json'
  /** Reject `NaN` / `Infinity` (always true: JSON.parse never accepts them). */
  strict = true

  async parse(c: Context): Promise<ParseResult> {
    const text = await c.req.text()
    if (!text.trim()) return { data: {}, files: {} }
    try {
      return { data: JSON.parse(text), files: {} }
    } catch (err) {
      throw new ParseError(`JSON parse error - ${(err as Error).message}`)
    }
  }
}

function formToData(form: FormData): ParseResult {
  const data: Record<string, any> = {}
  const files: Record<string, File | File[]> = {}
  const keys = new Set<string>()
  for (const k of form.keys()) keys.add(k)
  for (const k of keys) {
    const values = form.getAll(k)
    const strings = values.filter((v): v is string => typeof v === 'string')
    const blobs = values.filter((v): v is File => typeof v !== 'string')
    if (blobs.length) files[k] = blobs.length === 1 ? blobs[0] : blobs
    const all = [...strings, ...blobs]
    data[k] = all.length === 1 ? all[0] : all
  }
  return { data: markHtmlInput(data), files }
}

/** `application/x-www-form-urlencoded`. Repeated keys become arrays. */
export class FormParser extends BaseParser {
  readonly mediaType: string = 'application/x-www-form-urlencoded'

  async parse(c: Context): Promise<ParseResult> {
    try {
      return formToData(await c.req.formData())
    } catch (err) {
      throw new ParseError(`Form parse error - ${(err as Error).message}`)
    }
  }
}

/** `multipart/form-data`. Files are `File` objects, available in `request.data` and `request.files`. */
export class MultiPartParser extends BaseParser {
  readonly mediaType: string = 'multipart/form-data'

  async parse(c: Context): Promise<ParseResult> {
    try {
      return formToData(await c.req.formData())
    } catch (err) {
      throw new ParseError(`Multipart form parse error - ${(err as Error).message}`)
    }
  }
}

/**
 * Raw file upload (DRF's `FileUploadParser`): the whole body becomes `request.data.file`. The filename comes
 * from the `filename` URL kwarg or the `Content-Disposition` header.
 */
export class FileUploadParser extends BaseParser {
  readonly mediaType: string = '*/*'

  async parse(c: Context, mediaType: string, ctx: ParserContext): Promise<ParseResult> {
    const filename = (ctx.kwargs?.filename as string | undefined) ?? this.getFilename(c)
    if (!filename) {
      throw new ParseError(
        'Missing filename. Request should include a Content-Disposition header with a filename parameter.',
      )
    }
    const buf = await c.req.arrayBuffer()
    const type = mediaType && mediaType !== '*/*' ? mediaType : 'application/octet-stream'
    const file = new File([buf], filename, { type })
    return { data: markHtmlInput({ file }), files: { file } }
  }

  getFilename(c: Context): string | undefined {
    const cd = c.req.header('content-disposition') ?? ''
    const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd)
    if (star) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
      } catch {
        return star[1].trim()
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)
    return plain?.[1].trim()
  }
}

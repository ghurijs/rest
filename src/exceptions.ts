import {
  MethodNotAllowed as CoreMethodNotAllowed,
  PermissionDenied as CorePermissionDenied,
  ValidationError as CoreValidationError,
  GhuriError,
  Http404,
  HttpError,
  ObjectDoesNotExist,
  registerExceptionHandler,
  toJson,
} from '@ghuri/core'
import { APIResponse } from './response'
import { apiSettings } from './settings'
import { formatMessage } from './utils'

/** A message with a machine-readable code (DRF's `ErrorDetail`). Serializes to the plain message. */
export class ErrorDetail {
  constructor(
    readonly message: string,
    readonly code?: string,
  ) {}
  toString(): string {
    return this.message
  }
  toJSON(): string {
    return this.message
  }
}

/** Error messages as returned in responses: strings in lists / dicts. */
export type ErrorTree = string | ErrorTree[] | { [key: string]: ErrorTree }
/** What exception constructors accept. */
export type ErrorDetailInput = string | ErrorDetail | ErrorDetailInput[] | { [key: string]: ErrorDetailInput }

export interface FullErrorDetail {
  message: string
  code: string
}
export type FullErrorTree = FullErrorDetail | FullErrorTree[] | { [key: string]: FullErrorTree }

function normalize(input: unknown, code: string): { detail: ErrorTree; codes: ErrorTree } {
  if (input instanceof ErrorDetail) return { detail: input.message, codes: input.code ?? code }
  if (Array.isArray(input)) {
    const parts = input.map((x) => normalize(x, code))
    return { detail: parts.map((p) => p.detail), codes: parts.map((p) => p.codes) }
  }
  if (input instanceof APIException) return { detail: input.detail, codes: input.codes }
  if (input instanceof CoreValidationError) return normalize(coreValidationDetail(input), input.code ?? code)
  if (input && typeof input === 'object') {
    const detail: Record<string, ErrorTree> = {}
    const codes: Record<string, ErrorTree> = {}
    for (const [k, v] of Object.entries(input)) {
      const n = normalize(v, code)
      detail[k] = n.detail
      codes[k] = n.codes
    }
    return { detail, codes }
  }
  return { detail: String(input), codes: code }
}

function combine(detail: ErrorTree, codes: ErrorTree): FullErrorTree {
  if (Array.isArray(detail)) return detail.map((d, i) => combine(d, (codes as ErrorTree[])[i] ?? 'invalid'))
  if (detail && typeof detail === 'object') {
    const out: Record<string, FullErrorTree> = {}
    for (const [k, v] of Object.entries(detail)) out[k] = combine(v, (codes as Record<string, ErrorTree>)[k])
    return out
  }
  return { message: String(detail), code: String(codes) }
}

/**
 * Base class for REST framework exceptions (DRF's `APIException`). Subclasses set `statusCode`,
 * `defaultDetail` and `defaultCode`:
 *
 * ```ts
 * class ServiceUnavailable extends APIException {
 *   static statusCode = 503
 *   static defaultDetail = 'Service temporarily unavailable, try again later.'
 *   static defaultCode = 'service_unavailable'
 * }
 * ```
 */
export class APIException extends GhuriError {
  static statusCode = 500
  static defaultDetail: ErrorDetailInput = 'A server error occurred.'
  static defaultCode = 'error'

  statusCode: number
  /** Messages: a string, or a list / dict of messages for validation errors. */
  detail: ErrorTree
  /** Same shape as `detail`, with codes instead of messages. */
  codes: ErrorTree
  /** `WWW-Authenticate` header (set by the view for 401 responses). */
  authHeader?: string
  /** Seconds until the request may be retried (`Retry-After`). */
  wait?: number | null

  constructor(detail?: ErrorDetailInput | null, code?: string | null) {
    const cls = new.target as unknown as typeof APIException
    const n = normalize(detail ?? cls.defaultDetail, code ?? cls.defaultCode)
    super(typeof n.detail === 'string' ? n.detail : JSON.stringify(n.detail))
    this.statusCode = cls.statusCode
    this.detail = n.detail
    this.codes = n.codes
  }

  /** Alias of `statusCode` (core `HttpError` naming). */
  get status(): number {
    return this.statusCode
  }

  getCodes(): ErrorTree {
    return this.codes
  }

  getFullDetails(): FullErrorTree {
    return combine(this.detail, this.codes)
  }

  override toString(): string {
    return typeof this.detail === 'string' ? this.detail : JSON.stringify(this.detail)
  }
}

/** 400 with field errors: `{ field: ['msg'] }` or `['msg']`. Strings are wrapped in a list like DRF. */
export class ValidationError extends APIException {
  static override statusCode = 400
  static override defaultDetail = 'Invalid input.'
  static override defaultCode = 'invalid'

  constructor(detail?: ErrorDetailInput | null, code?: string | null) {
    let d: unknown = detail ?? (ValidationError.defaultDetail as string)
    if (typeof d === 'string' || d instanceof ErrorDetail) d = [d]
    super(d as ErrorDetailInput, code)
  }
}

export class ParseError extends APIException {
  static override statusCode = 400
  static override defaultDetail = 'Malformed request.'
  static override defaultCode = 'parse_error'
}

export class AuthenticationFailed extends APIException {
  static override statusCode = 401
  static override defaultDetail = 'Incorrect authentication credentials.'
  static override defaultCode = 'authentication_failed'
}

export class NotAuthenticated extends APIException {
  static override statusCode = 401
  static override defaultDetail = 'Authentication credentials were not provided.'
  static override defaultCode = 'not_authenticated'
}

export class PermissionDenied extends APIException {
  static override statusCode = 403
  static override defaultDetail = 'You do not have permission to perform this action.'
  static override defaultCode = 'permission_denied'
}

export class NotFound extends APIException {
  static override statusCode = 404
  static override defaultDetail = 'Not found.'
  static override defaultCode = 'not_found'
}

export class MethodNotAllowed extends APIException {
  static override statusCode = 405
  static override defaultDetail = 'Method "{method}" not allowed.'
  static override defaultCode = 'method_not_allowed'

  constructor(
    readonly method: string,
    detail?: ErrorDetailInput | null,
    code?: string | null,
  ) {
    super(detail ?? formatMessage(MethodNotAllowed.defaultDetail, { method: method.toUpperCase() }), code)
  }
}

export class NotAcceptable extends APIException {
  static override statusCode = 406
  static override defaultDetail = 'Could not satisfy the request Accept header.'
  static override defaultCode = 'not_acceptable'

  constructor(
    detail?: ErrorDetailInput | null,
    code?: string | null,
    readonly availableRenderers?: unknown[],
  ) {
    super(detail, code)
  }
}

export class UnsupportedMediaType extends APIException {
  static override statusCode = 415
  static override defaultDetail = 'Unsupported media type "{media_type}" in request.'
  static override defaultCode = 'unsupported_media_type'

  constructor(
    readonly mediaType: string,
    detail?: ErrorDetailInput | null,
    code?: string | null,
  ) {
    super(detail ?? formatMessage(UnsupportedMediaType.defaultDetail, { media_type: mediaType }), code)
  }
}

export class Throttled extends APIException {
  static override statusCode = 429
  static override defaultDetail = 'Request was throttled.'
  static override defaultCode = 'throttled'
  static extraDetailSingular = 'Expected available in {wait} second.'
  static extraDetailPlural = 'Expected available in {wait} seconds.'

  constructor(wait?: number | null, detail?: string | null, code?: string | null) {
    const base = detail ?? (Throttled.defaultDetail as string)
    const w = wait === undefined || wait === null ? null : Math.ceil(wait)
    const extra =
      w === null
        ? ''
        : ` ${formatMessage(w === 1 ? Throttled.extraDetailSingular : Throttled.extraDetailPlural, { wait: w })}`
    super(`${base}${extra}`, code)
    this.wait = w
  }
}

/** Server error raised for programming mistakes caught at runtime (DRF raises AssertionError/ImproperlyConfigured). */
export class ImproperlyConfiguredError extends GhuriError {}

// ---------------------------------------------------------------------------------------------
// Mapping other errors and the exception handler
// ---------------------------------------------------------------------------------------------

/** Turn a core ValidationError into DRF's error shape (`__all__` → `NON_FIELD_ERRORS_KEY`). */
export function coreValidationDetail(err: CoreValidationError): ErrorDetailInput {
  if (!err.messageDict) return err.messages.map((m) => new ErrorDetail(m, err.code ?? 'invalid'))
  const key = nonFieldErrorsKey()
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(err.messageDict)) out[k === '__all__' ? key : k] = v
  return out
}

export function nonFieldErrorsKey(): string {
  try {
    return apiSettings.NON_FIELD_ERRORS_KEY
  } catch {
    return 'nonFieldErrors'
  }
}

/**
 * Convert errors from core / the ORM into REST exceptions: `Http404` and `DoesNotExist` → `NotFound`, core
 * `PermissionDenied` (incl. CSRF failures) → `PermissionDenied`, core `ValidationError` (e.g. from
 * `fullClean()`) → `ValidationError`, core `MethodNotAllowed` → `MethodNotAllowed`, other 4xx `HttpError`s keep
 * their status. Returns null for anything else (→ 500 by core's handler).
 */
export function toAPIException(exc: unknown): APIException | null {
  if (exc instanceof APIException) return exc
  if (exc instanceof Http404) return new NotFound(exc.message || undefined)
  if (exc instanceof ObjectDoesNotExist) return new NotFound()
  if (exc instanceof CorePermissionDenied) return new PermissionDenied(exc.message || undefined)
  if (exc instanceof CoreValidationError) return new ValidationError(coreValidationDetail(exc))
  if (exc instanceof CoreMethodNotAllowed) return new MethodNotAllowed(exc.method)
  if (exc instanceof HttpError && exc.status < 500) {
    const e = new APIException(exc.message)
    e.statusCode = exc.status
    return e
  }
  return null
}

export interface ExceptionHandlerContext {
  view?: unknown
  request?: unknown
  args?: unknown[]
  kwargs?: Record<string, unknown>
}

export type ExceptionHandlerFunction = (
  exc: unknown,
  context: ExceptionHandlerContext,
) => APIResponse | null | undefined | Promise<APIResponse | null | undefined>

/**
 * The default `EXCEPTION_HANDLER`: returns an `APIResponse` for REST exceptions (and mapped core/ORM errors),
 * or null to let the error propagate (→ 500). Override with `REST_FRAMEWORK.EXCEPTION_HANDLER`:
 *
 * ```ts
 * function customHandler(exc, context) {
 *   const response = exceptionHandler(exc, context)
 *   if (response) response.data = { ...response.data, statusCode: response.status }
 *   return response
 * }
 * ```
 */
export function exceptionHandler(exc: unknown, _context: ExceptionHandlerContext = {}): APIResponse | null {
  const api = toAPIException(exc)
  if (!api) return null
  const headers = new Headers()
  if (api.authHeader) headers.set('WWW-Authenticate', api.authHeader)
  if (api.wait !== undefined && api.wait !== null) headers.set('Retry-After', String(api.wait))
  const data = typeof api.detail === 'string' ? { detail: api.detail } : api.detail
  return new APIResponse(data, { status: api.statusCode, headers })
}

// REST exceptions raised outside an APIView (plain views, middleware) still get DRF-shaped JSON.
registerExceptionHandler(APIException, (err: APIException) => {
  const data = typeof err.detail === 'string' ? { detail: err.detail } : err.detail
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=UTF-8' }
  if (err.authHeader) headers['www-authenticate'] = err.authHeader
  if (err.wait !== undefined && err.wait !== null) headers['retry-after'] = String(err.wait)
  return new Response(toJson(data), { status: err.statusCode, headers })
})

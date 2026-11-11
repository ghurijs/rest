import { AnonymousUser, type RequestUser, tryGetContext } from '@ghuri/core'
import type { AuthenticationClass } from './authentication'
import { MiddlewareAuthentication } from './authentication'
import type { ExceptionHandlerFunction } from './exceptions'
import { exceptionHandler } from './exceptions'
import type { FilterBackendClass } from './filters'
import { SimpleMetadata } from './metadata'
import type { ContentNegotiationClass } from './negotiation'
import { DefaultContentNegotiation } from './negotiation'
import type { PaginationClass } from './pagination'
import type { ParserClass } from './parsers'
import { FormParser, JSONParser, MultiPartParser } from './parsers'
import type { PermissionClass } from './permissions'
import { AllowAny } from './permissions'
import type { RendererClass } from './renderers'
import { BrowsableAPIRenderer, JSONRenderer } from './renderers'
import { AutoSchema } from './schemas/openapi'
import type { ThrottleClass } from './throttling'

/** `REST_FRAMEWORK` settings (DRF names, camelCase where DRF uses snake_case values). */
export interface RestFrameworkSettings {
  DEFAULT_RENDERER_CLASSES: RendererClass[]
  DEFAULT_PARSER_CLASSES: ParserClass[]
  /**
   * Default: `[MiddlewareAuthentication]` (the user set by `AuthenticationMiddleware`, with CSRF enforced like
   * DRF's SessionAuthentication). Add `TokenAuthentication`, `JWTAuthentication`… from `@ghuri/auth/rest`.
   */
  DEFAULT_AUTHENTICATION_CLASSES: AuthenticationClass[]
  DEFAULT_PERMISSION_CLASSES: PermissionClass[]
  DEFAULT_THROTTLE_CLASSES: ThrottleClass[]
  DEFAULT_CONTENT_NEGOTIATION_CLASS: ContentNegotiationClass
  DEFAULT_METADATA_CLASS: new () => { determineMetadata(request: any, view: any): Promise<unknown> | unknown }
  DEFAULT_PAGINATION_CLASS: PaginationClass | null
  DEFAULT_FILTER_BACKENDS: FilterBackendClass[]
  DEFAULT_SCHEMA_CLASS: new (...args: any[]) => any
  PAGE_SIZE: number | null
  /** Throttling */
  DEFAULT_THROTTLE_RATES: Record<string, string | null>
  NUM_PROXIES: number | null
  /** Cache alias used by throttles (default `'default'`). */
  THROTTLE_CACHE: string
  /** Authentication */
  UNAUTHENTICATED_USER: (() => RequestUser) | null
  UNAUTHENTICATED_TOKEN: (() => unknown) | null
  /** Filtering */
  SEARCH_PARAM: string
  ORDERING_PARAM: string
  /** Exception handling */
  EXCEPTION_HANDLER: ExceptionHandlerFunction
  NON_FIELD_ERRORS_KEY: string
  /** Generic view behavior */
  URL_FORMAT_OVERRIDE: string | null
  FORMAT_SUFFIX_KWARG: string
  URL_FIELD_NAME: string
  /** Input / output formats */
  DATE_FORMAT: string
  DATE_INPUT_FORMATS: string[]
  DATETIME_FORMAT: string
  DATETIME_INPUT_FORMATS: string[]
  TIME_FORMAT: string
  TIME_INPUT_FORMATS: string[]
  /** Encoding */
  COERCE_DECIMAL_TO_STRING: boolean
  UPLOADED_FILES_USE_URL: boolean
  COMPACT_JSON: boolean
  STRICT_JSON: boolean
  /** Browsable API */
  HTML_SELECT_CUTOFF: number
  HTML_SELECT_CUTOFF_TEXT: string
  /** Testing (`APIClient`) */
  TEST_REQUEST_DEFAULT_FORMAT: 'json' | 'multipart' | 'form'
  [key: string]: unknown
}

declare module '@ghuri/core' {
  interface GhuriSettings {
    /** `@ghuri/rest` settings (DRF's `REST_FRAMEWORK`). Unset keys use the defaults. */
    REST_FRAMEWORK?: Partial<RestFrameworkSettings>
  }
}

let defaultsCache: RestFrameworkSettings | undefined

/** DRF's defaults (built on first use: the classes live in modules that import this one). */
export function defaultSettings(): RestFrameworkSettings {
  defaultsCache ??= {
    DEFAULT_RENDERER_CLASSES: [JSONRenderer, BrowsableAPIRenderer],
    DEFAULT_PARSER_CLASSES: [JSONParser, FormParser, MultiPartParser],
    DEFAULT_AUTHENTICATION_CLASSES: [MiddlewareAuthentication],
    DEFAULT_PERMISSION_CLASSES: [AllowAny],
    DEFAULT_THROTTLE_CLASSES: [],
    DEFAULT_CONTENT_NEGOTIATION_CLASS: DefaultContentNegotiation,
    DEFAULT_METADATA_CLASS: SimpleMetadata,
    DEFAULT_PAGINATION_CLASS: null,
    DEFAULT_FILTER_BACKENDS: [],
    DEFAULT_SCHEMA_CLASS: AutoSchema,
    PAGE_SIZE: null,
    DEFAULT_THROTTLE_RATES: { user: null, anon: null },
    NUM_PROXIES: null,
    THROTTLE_CACHE: 'default',
    UNAUTHENTICATED_USER: () => new AnonymousUser(),
    UNAUTHENTICATED_TOKEN: null,
    SEARCH_PARAM: 'search',
    ORDERING_PARAM: 'ordering',
    EXCEPTION_HANDLER: exceptionHandler,
    NON_FIELD_ERRORS_KEY: 'nonFieldErrors',
    URL_FORMAT_OVERRIDE: 'format',
    FORMAT_SUFFIX_KWARG: 'format',
    URL_FIELD_NAME: 'url',
    DATE_FORMAT: 'iso-8601',
    DATE_INPUT_FORMATS: ['iso-8601'],
    DATETIME_FORMAT: 'iso-8601',
    DATETIME_INPUT_FORMATS: ['iso-8601'],
    TIME_FORMAT: 'iso-8601',
    TIME_INPUT_FORMATS: ['iso-8601'],
    COERCE_DECIMAL_TO_STRING: true,
    UPLOADED_FILES_USE_URL: true,
    COMPACT_JSON: true,
    STRICT_JSON: true,
    HTML_SELECT_CUTOFF: 1000,
    HTML_SELECT_CUTOFF_TEXT: 'More than {count} items...',
    TEST_REQUEST_DEFAULT_FORMAT: 'multipart',
  }
  return defaultsCache
}

/** The user's `REST_FRAMEWORK` dict of the current context (empty outside a context). */
export function userSettings(): Partial<RestFrameworkSettings> {
  const s = tryGetContext()?.settings.REST_FRAMEWORK
  return (s && typeof s === 'object' ? s : {}) as Partial<RestFrameworkSettings>
}

/**
 * Effective REST settings (DRF's `api_settings`): `REST_FRAMEWORK` of the current request merged over the
 * defaults. Read it at request time: `apiSettings.PAGE_SIZE`.
 */
export const apiSettings: RestFrameworkSettings = new Proxy({} as RestFrameworkSettings, {
  get(_t, key) {
    if (typeof key !== 'string') return undefined
    const user = userSettings() as Record<string, unknown>
    if (key === 'DEFAULT_THROTTLE_RATES')
      return { ...defaultSettings().DEFAULT_THROTTLE_RATES, ...((user[key] as object) ?? {}) }
    if (user[key] !== undefined) return user[key]
    return defaultSettings()[key]
  },
  has(_t, key) {
    return typeof key === 'string' && (key in userSettings() || key in defaultSettings())
  },
  ownKeys() {
    return [...new Set([...Object.keys(defaultSettings()), ...Object.keys(userSettings())])]
  },
  getOwnPropertyDescriptor(_t, key) {
    return { enumerable: true, configurable: true, value: (apiSettings as any)[key as string] }
  },
})

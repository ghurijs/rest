import { type Cache, caches, ImproperlyConfigured } from '@ghuri/core'
import type { APIRequest } from './request'
import { apiSettings } from './settings'
import type { MaybePromise } from './utils'

/** Rate limiting (DRF's `BaseThrottle`). */
export abstract class BaseThrottle {
  abstract allowRequest(request: APIRequest, view: any): MaybePromise<boolean>

  /**
   * Client identity: `X-Forwarded-For` honoring `NUM_PROXIES`, else the client address (`CF-Connecting-IP` on
   * Cloudflare, the socket address on Node).
   */
  getIdent(request: APIRequest): string {
    const xff = request.header('x-forwarded-for')
    const remote =
      request.header('cf-connecting-ip') ??
      (request.c.env as any)?.incoming?.socket?.remoteAddress ??
      request.header('x-real-ip') ??
      ''
    const numProxies = apiSettings.NUM_PROXIES
    if (numProxies !== null && numProxies !== undefined) {
      if (numProxies === 0 || !xff) return remote
      const addrs = xff.split(',')
      return addrs[addrs.length - Math.min(numProxies, addrs.length)].trim()
    }
    return xff ? xff.replace(/\s+/g, '') : remote
  }

  /** Seconds to wait before the next request is allowed (or null). */
  wait(): number | null {
    return null
  }
}

export type ThrottleClass = new () => BaseThrottle

/**
 * Rate limit by a cache key and a rate like `'100/hour'` (DRF's `SimpleRateThrottle`). Units: `s`, `m`,
 * `h`, `d` (only the first letter counts: `sec`, `minute`, `hour`, `day`…), optionally with a multiplier
 * (`'10/5m'`). Request history is kept in the core cache (`REST_FRAMEWORK.THROTTLE_CACHE`, default `'default'`).
 */
export abstract class SimpleRateThrottle extends BaseThrottle {
  scope?: string
  rate?: string | null
  cacheFormat = 'throttle_{scope}_{ident}'
  numRequests: number | null = null
  duration: number | null = null
  history: number[] = []
  now = 0
  key: string | null = null
  _cache?: Cache

  /** Current time in seconds (override in tests). */
  timer(): number {
    return Date.now() / 1000
  }

  get cache(): Cache {
    this._cache ??= caches.get(apiSettings.THROTTLE_CACHE ?? 'default')
    return this._cache
  }
  set cache(c: Cache) {
    this._cache = c
  }

  /** Cache key for this request, or null to skip throttling. */
  abstract getCacheKey(request: APIRequest, view: any): MaybePromise<string | null>

  getRate(): string | null {
    if (!this.scope) {
      throw new ImproperlyConfigured(
        `You must set either \`.scope\` or \`.rate\` for '${this.constructor.name}' throttle`,
      )
    }
    const rates = apiSettings.DEFAULT_THROTTLE_RATES
    if (!(this.scope in rates)) {
      throw new ImproperlyConfigured(`No default throttle rate set for '${this.scope}' scope`)
    }
    return rates[this.scope] ?? null
  }

  parseRate(rate: string | null | undefined): [number | null, number | null] {
    if (!rate) return [null, null]
    const [num, period] = rate.split('/')
    const m = /^(\d*)\s*([smhd])/i.exec(period.trim())
    if (!m) throw new ImproperlyConfigured(`Invalid throttle rate '${rate}'.`)
    const mult = m[1] ? Number.parseInt(m[1], 10) : 1
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd']
    return [Number.parseInt(num, 10), unit * mult]
  }

  formatKey(params: { scope: string; ident: string }): string {
    return this.cacheFormat.replace('{scope}', params.scope).replace('{ident}', params.ident)
  }

  async allowRequest(request: APIRequest, view: any): Promise<boolean> {
    if (this.rate === undefined) this.rate = this.getRate()
    ;[this.numRequests, this.duration] = this.parseRate(this.rate)
    if (this.rate === null || this.numRequests === null || this.duration === null) return true
    this.key = await this.getCacheKey(request, view)
    if (this.key === null) return true
    this.history = (await this.cache.get<number[]>(this.key)) ?? []
    this.now = this.timer()
    while (this.history.length && this.history[this.history.length - 1] <= this.now - this.duration)
      this.history.pop()
    if (this.history.length >= this.numRequests) return this.throttleFailure()
    return this.throttleSuccess()
  }

  async throttleSuccess(): Promise<boolean> {
    this.history.unshift(this.now)
    await this.cache.set(this.key!, this.history, this.duration!)
    return true
  }

  throttleFailure(): boolean {
    return false
  }

  override wait(): number | null {
    let remaining: number
    if (this.history.length) remaining = this.duration! - (this.now - this.history[this.history.length - 1])
    else remaining = this.duration!
    const available = this.numRequests! - this.history.length + 1
    if (available <= 0) return null
    return remaining / available
  }
}

/** Anonymous users, by IP (`DEFAULT_THROTTLE_RATES.anon`). */
export class AnonRateThrottle extends SimpleRateThrottle {
  override scope = 'anon'
  getCacheKey(request: APIRequest): string | null {
    if (request.user?.isAuthenticated) return null
    return this.formatKey({ scope: this.scope, ident: this.getIdent(request) })
  }
}

/** Authenticated users by id, anonymous users by IP (`DEFAULT_THROTTLE_RATES.user`). */
export class UserRateThrottle extends SimpleRateThrottle {
  override scope = 'user'
  getCacheKey(request: APIRequest): string | null {
    const ident = request.user?.isAuthenticated ? String(request.user.pk) : this.getIdent(request)
    return this.formatKey({ scope: this.scope, ident })
  }
}

/**
 * Per-view scopes: views set `throttleScope = 'uploads'` and `DEFAULT_THROTTLE_RATES.uploads` gives the rate.
 * Views without a scope are not throttled.
 */
export class ScopedRateThrottle extends SimpleRateThrottle {
  scopeAttr = 'throttleScope'

  override async allowRequest(request: APIRequest, view: any): Promise<boolean> {
    const scope = view?.[this.scopeAttr] ?? view?.constructor?.[this.scopeAttr]
    if (!scope) return true
    this.scope = scope
    this.rate = this.getRate()
    return super.allowRequest(request, view)
  }

  getCacheKey(request: APIRequest): string | null {
    const ident = request.user?.isAuthenticated ? String(request.user.pk) : this.getIdent(request)
    return this.formatKey({ scope: this.scope!, ident })
  }
}

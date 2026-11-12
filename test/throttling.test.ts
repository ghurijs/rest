import { path } from '@ghuri/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AnonRateThrottle,
  type APIRequest,
  APIView,
  ScopedRateThrottle,
  SimpleRateThrottle,
  UserRateThrottle,
} from '../src/index'
import { fakeUser, makeApi } from './helpers'

let now = 1_000_000
const Clock = {
  set(t: number) {
    now = t
  },
}
for (const T of [AnonRateThrottle, UserRateThrottle, ScopedRateThrottle]) T.prototype.timer = () => now

class Burst extends SimpleRateThrottle {
  override rate = '2/10s'
  override timer() {
    return now
  }
  getCacheKey(request: APIRequest) {
    return `burst_${this.getIdent(request)}`
  }
}

class Hello extends APIView {
  override throttleClasses = [AnonRateThrottle, UserRateThrottle]
  async get() {
    return { ok: true }
  }
}

class Uploads extends APIView {
  override throttleClasses = [ScopedRateThrottle]
  override throttleScope = 'uploads'
  async get() {
    return { ok: true }
  }
}

class Unscoped extends APIView {
  override throttleClasses = [ScopedRateThrottle]
  async get() {
    return { ok: true }
  }
}

class Bursty extends APIView {
  override throttleClasses = [Burst]
  async get() {
    return { ok: true }
  }
}

describe('throttling', () => {
  it('limits anonymous and authenticated users with Retry-After', async () => {
    const { client, db } = await makeApi({
      urls: [
        path('hello/', Hello),
        path('uploads/', Uploads),
        path('unscoped/', Unscoped),
        path('burst/', Bursty),
      ],
      rest: { DEFAULT_THROTTLE_RATES: { anon: '2/min', user: '5/hour', uploads: '1/day' }, NUM_PROXIES: 1 },
    })
    try {
      Clock.set(1_000_000)
      const h = { 'x-forwarded-for': '10.0.0.1' }
      expect((await client.get('/hello/', undefined, { headers: h })).status).toBe(200)
      expect((await client.get('/hello/', undefined, { headers: h })).status).toBe(200)
      const limited = await client.get('/hello/', undefined, { headers: h })
      expect(limited.status).toBe(429)
      expect(limited.data).toEqual({ detail: 'Request was throttled. Expected available in 60 seconds.' })
      expect(limited.headers.get('retry-after')).toBe('60')
      expect(
        (await client.get('/hello/', undefined, { headers: { 'x-forwarded-for': '10.0.0.2' } })).status,
      ).toBe(200)
      Clock.set(1_000_061)
      expect((await client.get('/hello/', undefined, { headers: h })).status).toBe(200)

      client.forceAuthenticate(fakeUser({ pk: 42 }))
      // Anonymous requests above count against UserRateThrottle by IP; user 42 has its own history.
      for (let i = 0; i < 5; i++)
        expect((await client.get('/hello/', undefined, { headers: h })).status).toBe(200)
      expect((await client.get('/hello/', undefined, { headers: h })).status).toBe(429)
      client.forceAuthenticate(fakeUser({ pk: 43 }))
      expect((await client.get('/hello/', undefined, { headers: h })).status).toBe(200)

      expect((await client.get('/uploads/')).status).toBe(200)
      const up = await client.get('/uploads/')
      expect(up.status).toBe(429)
      expect(up.data.detail).toBe('Request was throttled. Expected available in 86400 seconds.')
      for (let i = 0; i < 5; i++) expect((await client.get('/unscoped/')).status).toBe(200)

      client.forceAuthenticate(null)
      const ip = { 'x-forwarded-for': '1.2.3.4' }
      expect((await client.get('/burst/', undefined, { headers: ip })).status).toBe(200)
      expect((await client.get('/burst/', undefined, { headers: ip })).status).toBe(200)
      expect((await client.get('/burst/', undefined, { headers: ip })).status).toBe(429)
      Clock.set(1_000_072)
      expect((await client.get('/burst/', undefined, { headers: ip })).status).toBe(200)
    } finally {
      await db.teardown()
    }
  })

  it('parses rates and identifies clients', () => {
    const t = new Burst()
    expect(t.parseRate('100/hour')).toEqual([100, 3600])
    expect(t.parseRate('5/s')).toEqual([5, 1])
    expect(t.parseRate('10/5m')).toEqual([10, 300])
    expect(t.parseRate('1/day')).toEqual([1, 86400])
    expect(t.parseRate(null)).toEqual([null, null])
  })

  describe('client IP (getIdent)', () => {
    class Ident extends APIView {
      async get(request: APIRequest) {
        return { ident: new AnonRateThrottle().getIdent(request) }
      }
    }
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function identOf(
      rest: Record<string, unknown>,
      headers: Record<string, string>,
      env: Record<string, unknown> = {},
    ): Promise<string> {
      const h = await makeApi({ urls: [path('ident/', Ident)], rest: rest as any })
      try {
        Object.assign(h.env, env)
        const res = await h.client.get('/ident/', undefined, { headers })
        expect(res.status).toBe(200)
        return res.data.ident
      } finally {
        await h.db.teardown()
      }
    }

    it('ignores client-sent X-Forwarded-For, X-Real-IP and CF-Connecting-IP by default', async () => {
      const spoofed = { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', 'cf-connecting-ip': '8.8.8.8' }
      expect(await identOf({}, spoofed)).toBe('')
      // two requests with different spoofed values share one identity
      expect(await identOf({}, { 'x-forwarded-for': '6.6.6.7' })).toBe('')
    })

    it('uses the socket address on Node', async () => {
      const env = { incoming: { socket: { remoteAddress: '203.0.113.9' } } }
      expect(await identOf({}, { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '8.8.8.8' }, env)).toBe(
        '203.0.113.9',
      )
    })

    it('uses CF-Connecting-IP on Cloudflare Workers, not X-Forwarded-For', async () => {
      vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
      expect(await identOf({}, { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6' })).toBe(
        '198.51.100.7',
      )
    })

    it('reads X-Forwarded-For only when NUM_PROXIES is set (DRF semantics)', async () => {
      const env = { incoming: { socket: { remoteAddress: '10.0.0.5' } } }
      const xff = { 'x-forwarded-for': '6.6.6.6, 198.51.100.1, 10.0.0.2' }
      expect(await identOf({ NUM_PROXIES: 1 }, xff, env)).toBe('10.0.0.2')
      expect(await identOf({ NUM_PROXIES: 2 }, xff, env)).toBe('198.51.100.1')
      expect(await identOf({ NUM_PROXIES: 10 }, xff, env)).toBe('6.6.6.6')
      expect(await identOf({ NUM_PROXIES: 0 }, xff, env)).toBe('10.0.0.5')
      expect(await identOf({ NUM_PROXIES: 1 }, {}, env)).toBe('10.0.0.5')
    })
  })
})

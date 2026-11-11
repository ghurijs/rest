import { path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
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
      rest: { DEFAULT_THROTTLE_RATES: { anon: '2/min', user: '5/hour', uploads: '1/day' } },
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
      const ip = { 'cf-connecting-ip': '1.2.3.4' }
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
})

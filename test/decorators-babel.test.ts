// Regression: legacy decorators as compiled by Babel with decorator metadata (jiti — the `ghuri` CLI's
// TypeScript loader). Babel's no-op metadata decorators `(t) => t` return the class prototype, which is then
// passed to the next decorator in place of the property descriptor.
import { describe, expect, it } from 'vitest'
import { action, extendSchema, getExtraActions, SCHEMA_EXTENSION } from '../src/decorators'

/** What `_applyDecoratedDescriptor(proto, key, [decorators..., metadata, metadata], desc, proto)` does. */
function applyBabelLegacy(proto: any, key: string, decorators: Array<(...a: any[]) => any>): void {
  const metadata = (t: unknown) => t
  const desc = Object.getOwnPropertyDescriptor(proto, key)!
  const result = [...decorators, metadata, metadata]
    .slice()
    .reverse()
    .reduce((d: any, dec) => dec(proto, key, d) || d, { ...desc })
  Object.defineProperty(proto, key, result)
}

describe('decorators compiled by Babel (legacy + metadata)', () => {
  it('@action and @extendSchema mark the method', () => {
    class V {
      async publish() {
        return 'ok'
      }
    }
    applyBabelLegacy(V.prototype, 'publish', [
      extendSchema({ summary: 'Publish' }),
      action({ detail: true, methods: ['post'] }),
    ])
    expect(typeof V.prototype.publish).toBe('function')
    expect(getExtraActions(V).map((a) => [a.name, a.detail, a.methods])).toEqual([
      ['publish', true, ['post']],
    ])
    expect((V.prototype.publish as any)[SCHEMA_EXTENSION]).toEqual({ summary: 'Publish' })
  })
})

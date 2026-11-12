// Minimal YAML emitter for JSON data (OpenAPI documents), so `generateschema` needs no YAML dependency.
// Block style throughout; strings that could be read as anything but a string are double-quoted
// (JSON string escapes are valid YAML double-quoted escapes).

const RESERVED = /^(?:~|null|true|false|yes|no|on|off|y|n|\.nan|\.inf|-\.inf)$/i
const PLAIN_KEY = /^[A-Za-z_$][\w$.-]*$/
const PLAIN_STRING = /^[A-Za-z_$][\w$.,/()'-]*(?: [\w$.,/()'-]+)*$/

function key(k: string): string {
  return PLAIN_KEY.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k)
}

function str(s: string): string {
  return PLAIN_STRING.test(s) && !RESERVED.test(s) ? s : JSON.stringify(s)
}

function isBlock(v: unknown): v is object {
  if (v === null || typeof v !== 'object') return false
  return Array.isArray(v) ? v.length > 0 : Object.values(v).some((x) => x !== undefined)
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return str(v)
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (Array.isArray(v)) return '[]'
  if (typeof v === 'object') return '{}'
  return 'null'
}

function block(v: object, indent: number): string {
  const pad = ' '.repeat(indent)
  if (Array.isArray(v)) {
    return v
      .map((item) =>
        isBlock(item) ? `${pad}- ${block(item, indent + 2).slice(indent + 2)}` : `${pad}- ${scalar(item)}`,
      )
      .join('\n')
  }
  return Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) =>
      isBlock(x) ? `${pad}${key(k)}:\n${block(x, indent + 2)}` : `${pad}${key(k)}: ${scalar(x)}`,
    )
    .join('\n')
}

/** Serialize JSON-compatible data as a YAML document (what `JSON.stringify` would keep). */
export function toYAML(value: unknown): string {
  return `${isBlock(value) ? block(value, 0) : scalar(value)}\n`
}

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bufferIO,
  CommandError,
  callCommand,
  createContext,
  include,
  path,
  runWithContext,
} from '@ghuri/core'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DefaultRouter,
  GenerateSchemaCommand,
  generateSchema,
  ModelSerializer,
  ModelViewSet,
  RestFrameworkConfig,
  SchemaView,
} from '../src/index'
import { toYAML } from '../src/schemas/yaml'
import { Tag } from './models'

class TagSerializer extends ModelSerializer {
  static Meta = { model: Tag, fields: ['id', 'name'] }
}
class TagViewSet extends ModelViewSet {
  queryset = Tag.objects.all()
  serializerClass = TagSerializer
}
const router = new DefaultRouter()
router.register('tags', TagViewSet)

const withSchemaView = [
  path('api/schema/', SchemaView.asView({ title: 'Tags API', version: '3.0.0' }), { name: 'schema' }),
  path('api/', include(router.urls)),
]
const withoutSchemaView = [path('api/', include(router.urls))]

function ctx(urls: unknown) {
  return createContext({
    env: {},
    settings: { SECRET_KEY: 'x', INSTALLED_APPS: [], ROOT_URLCONF: urls } as any,
  })
}

async function run(urls: unknown, args: Record<string, unknown> = {}) {
  const io = bufferIO()
  await runWithContext(ctx(urls), () => callCommand(GenerateSchemaCommand, args, io))
  return io
}

const dir = mkdtempSync(join(tmpdir(), 'ghuri-rest-schema-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('generateschema command', () => {
  it('is exposed by RestFrameworkConfig', () => {
    const config = new RestFrameworkConfig()
    expect(config.appLabel).toBe('rest_framework')
    expect(config.commands.generateschema).toBe(GenerateSchemaCommand)
  })

  it('prints YAML of ROOT_URLCONF using the routed SchemaView', async () => {
    const out = (await run(withSchemaView)).out.join('\n')
    expect(out).toContain('openapi: "3.1.0"')
    expect(out).toMatch(/info:\n {2}title: Tags API\n {2}version: "3\.0\.0"/)
    expect(out).toContain('"/api/tags/{id}/":')
    expect(out).not.toContain('/api/schema/')
  })

  it('writes JSON matching what SchemaView serves', async () => {
    const file = join(dir, 'openapi.json')
    const io = await run(withSchemaView, { file })
    expect(io.out.join('\n')).toContain(`Successfully wrote the OpenAPI schema to ${file}`)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc).toEqual(generateSchema(withSchemaView, { title: 'Tags API', version: '3.0.0' }))
  })

  it('flags override the SchemaView; --format forces JSON on stdout', async () => {
    const out = (
      await run(withSchemaView, {
        format: 'openapi-json',
        title: 'Other',
        description: 'Tags.',
        apiVersion: '9',
        url: 'https://api.example.com',
        indent: '0',
      })
    ).out.join('\n')
    const doc = JSON.parse(out)
    expect(doc.info).toEqual({ title: 'Other', version: '9', description: 'Tags.' })
    expect(doc.servers).toEqual([{ url: 'https://api.example.com' }])
    expect(out.split('\n')).toHaveLength(1)
  })

  it('documents a urlconf without a SchemaView', async () => {
    const file = join(dir, 'schema.yaml')
    await run(withoutSchemaView, { file, title: 'Plain' })
    const yaml = readFileSync(file, 'utf8')
    expect(yaml).toMatch(/info:\n {2}title: Plain\n/)
    expect(yaml).toContain('"/api/tags/":')
  })

  it('rejects unknown formats and missing ROOT_URLCONF', async () => {
    await expect(run(withSchemaView, { format: 'xml' })).rejects.toThrow(CommandError)
    await expect(run(undefined)).rejects.toThrow(/ROOT_URLCONF/)
  })
})

describe('toYAML', () => {
  it('emits block YAML and quotes anything not a plain string', () => {
    expect(
      toYAML({
        openapi: '3.1.0',
        info: { title: 'Blog API', description: 'Line one.\nLine two: "quoted"' },
        paths: {
          '/api/posts/{id}/': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true }],
              responses: { '200': { $ref: '#/components/responses/Ok' } },
            },
          },
        },
        enum: ['draft', 'yes', 'null', '', 'a: b', 1, 2.5, false, null],
        nested: [[1, 2], [], {}],
        empty: {},
        skipped: undefined,
      }),
    ).toBe(`openapi: "3.1.0"
info:
  title: Blog API
  description: "Line one.\\nLine two: \\"quoted\\""
paths:
  "/api/posts/{id}/":
    get:
      parameters:
        - name: id
          in: path
          required: true
      responses:
        "200":
          $ref: "#/components/responses/Ok"
enum:
  - draft
  - "yes"
  - "null"
  - ""
  - "a: b"
  - 1
  - 2.5
  - false
  - null
nested:
  - - 1
    - 2
  - []
  - {}
empty: {}
`)
  })
})

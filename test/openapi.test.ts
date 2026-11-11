import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  type APIRequest,
  APIView,
  AutoSchema,
  action,
  apiView,
  type BaseAuthentication,
  CharField,
  DefaultRouter,
  extendSchema,
  FieldFilter,
  generateSchema,
  getEndpoints,
  IntegerField,
  IsAuthenticatedOrReadOnly,
  ModelSerializer,
  ModelViewSet,
  OrderingFilter,
  PageNumberPagination,
  ReadOnlyModelViewSet,
  ScalarView,
  SchemaView,
  SearchFilter,
  Serializer,
  SwaggerUIView,
} from '../src/index'
import { useApi } from './helpers'
import { Member, Post, Tag } from './models'

class TokenAuth implements BaseAuthentication {
  static securityScheme = { name: 'tokenAuth', scheme: { type: 'http', scheme: 'bearer' } }
  async authenticate() {
    return null
  }
  authenticateHeader() {
    return 'Bearer'
  }
}

class MemberSerializer extends ModelSerializer {
  static Meta = { model: Member, fields: ['id', 'username'] }
}

class PostSerializer extends ModelSerializer {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'status', 'rating', 'author', 'tags', 'createdAt'],
  }
  authorDetail = new MemberSerializer({ source: 'author', readOnly: true })
}

class PublishResultSerializer extends Serializer {
  status = new CharField()
  id = new IntegerField()
}

class Pages extends PageNumberPagination {
  override pageSize = 10
}

class PostViewSet extends ModelViewSet {
  override authenticationClasses = [TokenAuth]
  override permissionClasses = [IsAuthenticatedOrReadOnly]
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  override paginationClass = Pages
  override filterBackends = [SearchFilter, OrderingFilter, FieldFilter]
  override searchFields = ['title']
  override orderingFields = ['title']
  override filtersetFields = { published: ['exact'], views: ['gte', 'in'] }

  @extendSchema({
    summary: 'Publish a post',
    request: null,
    responses: PublishResultSerializer,
    tags: ['publishing'],
  })
  @action({ detail: true, methods: ['post'] })
  async publish(_request: APIRequest) {
    return { status: 'ok', id: 1 }
  }

  @extendSchema({ exclude: true })
  @action({ detail: false })
  async hidden() {
    return {}
  }
}

class TagViewSet extends ReadOnlyModelViewSet {
  queryset = Tag.objects.all()
  serializerClass = class TagSerializer extends ModelSerializer {
    static Meta = { model: Tag, fields: ['id', 'name'] }
  }
  override schema = new AutoSchema({ tags: ['labels'], operationIdBase: 'Label' })
}

class Ping extends APIView {
  static override description = 'Health check.'
  async get() {
    return { pong: true }
  }
}

const router = new DefaultRouter()
router.register('posts', PostViewSet)
router.register('tags', TagViewSet)

const hello = apiView(['GET'])(async function sayHello() {
  return { hi: true }
})

const urls = [
  path('api/', include(router.urls)),
  path('api/ping/', Ping),
  path('api/hello/', hello),
  path('api/schema/', SchemaView.asView({ title: 'Blog API', version: '2.0.0' }), { name: 'schema' }),
  path('api/docs/', SwaggerUIView.asView({ urlName: 'schema' })),
  path('api/reference/', ScalarView.asView({ urlName: 'schema' })),
]

describe('OpenAPI 3.1 generation', () => {
  void Member._meta
  const doc = generateSchema(urls, { title: 'Blog API', version: '2.0.0', description: 'Posts and tags.' })

  it('describes paths and operations', () => {
    expect(
      getEndpoints(urls)
        .filter((e) => e.path === '/api/hello/')
        .map((e) => e.cls.name),
    ).toEqual(['SayHello'])
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'Blog API', version: '2.0.0', description: 'Posts and tags.' })
    expect(Object.keys(doc.paths)).toEqual([
      '/api/posts/',
      '/api/posts/{id}/',
      '/api/posts/{id}/publish/',
      '/api/tags/',
      '/api/tags/{id}/',
      '/api/ping/',
      '/api/hello/',
    ])
    const ops = Object.fromEntries(
      Object.entries(doc.paths).flatMap(([p, methods]: [string, any]) =>
        Object.entries(methods).map(([m, op]: [string, any]) => [`${m.toUpperCase()} ${p}`, op.operationId]),
      ),
    )
    expect(ops).toEqual({
      'GET /api/posts/': 'listPosts',
      'POST /api/posts/': 'createPost',
      'GET /api/posts/{id}/': 'retrievePost',
      'PUT /api/posts/{id}/': 'updatePost',
      'PATCH /api/posts/{id}/': 'partialUpdatePost',
      'DELETE /api/posts/{id}/': 'destroyPost',
      'POST /api/posts/{id}/publish/': 'publishPost',
      'GET /api/tags/': 'listLabel',
      'GET /api/tags/{id}/': 'retrieveLabel',
      'GET /api/ping/': 'retrievePing',
      'GET /api/hello/': 'retrieveSayHello',
    })
  })

  it('documents parameters, bodies, responses and security', () => {
    const list = doc.paths['/api/posts/'].get
    expect(list.tags).toEqual(['posts'])
    expect(list.parameters.map((p: any) => p.name)).toEqual([
      'page',
      'search',
      'ordering',
      'published',
      'views__gte',
      'views__in',
    ])
    expect(list.parameters.find((p: any) => p.name === 'views__in').schema).toEqual({
      type: 'array',
      items: { type: 'integer' },
    })
    expect(list.responses['200'].content['application/json'].schema).toEqual({
      type: 'object',
      required: ['count', 'results'],
      properties: {
        count: { type: 'integer', examples: [123] },
        next: expect.any(Object),
        previous: expect.any(Object),
        results: { type: 'array', items: { $ref: '#/components/schemas/Post' } },
      },
    })
    expect(list.security).toEqual([{ tokenAuth: [] }, {}])
    const create = doc.paths['/api/posts/'].post
    expect(create.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PostRequest',
    })
    expect(Object.keys(create.requestBody.content)).toEqual([
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
    ])
    expect(create.responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Post',
    })
    expect(create.responses['400'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ValidationError',
    })
    expect(create.responses['401']).toBeDefined()
    const patch = doc.paths['/api/posts/{id}/'].patch
    expect(patch.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PatchedPostRequest',
    })
    expect(patch.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'A unique integer value identifying this post.',
        schema: { type: 'integer' },
      },
    ])
    expect(doc.paths['/api/posts/{id}/'].delete.responses['204']).toEqual({ description: 'No response body' })
    const publish = doc.paths['/api/posts/{id}/publish/'].post
    expect(publish.summary).toBe('Publish a post')
    expect(publish.tags).toEqual(['publishing'])
    expect(publish.requestBody).toBeUndefined()
    expect(publish.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PublishResult',
    })
    expect(doc.paths['/api/tags/'].get.tags).toEqual(['labels'])
    expect(doc.paths['/api/ping/'].get.description).toBe('Health check.')
    expect(doc.components.securitySchemes).toEqual({ tokenAuth: { type: 'http', scheme: 'bearer' } })
  })

  it('builds components from serializers (input / output / patched, nested refs)', () => {
    const {
      Post: out,
      PostRequest: input,
      PatchedPostRequest: patched,
      Member: member,
    } = doc.components.schemas
    expect(out.required).toEqual(['id', 'title', 'slug', 'author', 'createdAt', 'authorDetail'])
    expect(out.properties.authorDetail).toMatchObject({ $ref: '#/components/schemas/Member', readOnly: true })
    expect(out.properties.status).toMatchObject({ enum: ['draft', 'live'] })
    expect(out.properties.createdAt).toMatchObject({ type: 'string', format: 'date-time', readOnly: true })
    expect(Object.keys(input.properties)).toEqual(['title', 'slug', 'status', 'rating', 'author', 'tags'])
    expect(input.required).toEqual(['title', 'slug', 'author'])
    expect(patched.required).toBeUndefined()
    expect(member.properties.username).toMatchObject({ type: 'string', maxLength: 50 })
    expect(doc.components.schemas.ValidationError).toBeDefined()
  })

  it('matches the snapshot', () => {
    expect(doc).toMatchSnapshot()
  })

  it('accepts a router with a prefix', () => {
    const fromRouter = generateSchema(router, { prefix: 'v1/' })
    expect(Object.keys(fromRouter.paths)).toContain('/v1/posts/{id}/publish/')
    expect(fromRouter.info).toEqual({ title: 'API', version: '1.0.0' })
  })
})

describe('schema views', () => {
  const api = useApi(() => ({ urls }))

  it('serves JSON and documentation pages', async () => {
    const res = await api.client.get('/api/schema/')
    expect(res.status).toBe(200)
    expect(res.data.info).toEqual({ title: 'Blog API', version: '2.0.0' })
    expect(Object.keys(res.data.paths)).toContain('/api/posts/')
    expect(Object.keys(res.data.paths)).not.toContain('/api/schema/')
    const oai = await api.client.get('/api/schema/', undefined, {
      headers: { Accept: 'application/vnd.oai.openapi+json' },
    })
    expect(oai.headers.get('content-type')).toContain('application/vnd.oai.openapi+json')
    const swagger = await api.client.get('/api/docs/')
    expect(swagger.headers.get('content-type')).toContain('text/html')
    const html = await swagger.text()
    expect(html).toContain('swagger-ui-bundle.js')
    expect(html).toContain('"/api/schema/"')
    const scalar = await (await api.client.get('/api/reference/')).text()
    expect(scalar).toContain('data-url="/api/schema/"')
    expect(scalar).toContain('@scalar/api-reference')
  })
})

describe('router introspection', () => {
  it('exposes registrations, routes, endpoints and JSON Schemas', () => {
    expect(router.registry.map((r) => [r.prefix, r.basename, r.viewset.name])).toEqual([
      ['posts', 'post', 'PostViewSet'],
      ['tags', 'tag', 'TagViewSet'],
    ])
    const posts = router.registry[0]
    expect(posts.model).toBe(Post)
    expect(posts.actions).toEqual([
      'list',
      'create',
      'hidden',
      'retrieve',
      'update',
      'partialUpdate',
      'destroy',
      'publish',
    ])
    expect(posts.routes.map((r) => [r.name, r.pattern, r.detail])).toEqual([
      ['post-list', 'posts/', false],
      ['post-hidden', 'posts/hidden/', false],
      ['post-detail', 'posts/<restlookup:pk>/', true],
      ['post-publish', 'posts/<restlookup:pk>/publish/', true],
    ])
    expect(posts.endpoints.find((e) => e.action === 'publish')).toMatchObject({
      method: 'POST',
      detail: true,
      extra: true,
    })
    expect(posts.extraActions.map((a) => [a.name, a.urlPath, a.methods])).toEqual([
      ['publish', 'publish', ['post']],
      ['hidden', 'hidden', ['get']],
    ])
    expect(posts.getSerializerClass('create')).toBe(PostSerializer)
    const input = posts.jsonSchema('create', { mode: 'input' })!
    expect(input.required).toEqual(['title', 'slug', 'author'])
    expect(router.describe()[1]).toMatchObject({
      prefix: 'tags',
      basename: 'tag',
      model: 'blog.Tag',
      actions: ['list', 'retrieve'],
    })
    expect(() => router.register('posts', PostViewSet)).toThrow(/already registered/)
  })
})

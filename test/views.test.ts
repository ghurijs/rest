import {
  PermissionDenied as CorePermissionDenied,
  ValidationError as CoreValidationError,
  Http404,
  path,
  XFrameOptionsMiddleware,
  xframeOptionsExempt,
} from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  APIException,
  type APIRequest,
  APIResponse,
  APIView,
  apiView,
  CharField,
  exceptionHandler,
  FileField,
  FileUploadParser,
  ImageField,
  IsAuthenticated,
  JSONParser,
  JSONRenderer,
  ListCreateAPIView,
  ListField,
  ModelSerializer,
  NotFound,
  RetrieveUpdateDestroyAPIView,
  Serializer,
  status,
  ViewSet,
} from '../src/index'
import { backends, fakeUser, makeApi, useApi } from './helpers'
import { Member, Post } from './models'

class Echo extends APIView {
  async get(request: APIRequest) {
    return { method: request.method, query: request.query, all: request.queryParams.getAll('tag') }
  }
  async post(request: APIRequest) {
    return new APIResponse(
      { data: request.data, contentType: request.contentType.split(';')[0] },
      status.HTTP_201_CREATED,
    )
  }
}

class JsonOnly extends APIView {
  override parserClasses = [JSONParser]
  override rendererClasses = [JSONRenderer]
  async post(request: APIRequest) {
    return request.data
  }
}

class ServiceUnavailable extends APIException {
  static override statusCode = 503
  static override defaultDetail = 'Service temporarily unavailable, try again later.'
  static override defaultCode = 'service_unavailable'
}

class Raiser extends APIView {
  async get(request: APIRequest) {
    switch (request.query.kind) {
      case 'http404':
        throw new Http404('Nothing here.')
      case 'denied':
        throw new CorePermissionDenied('Go away.')
      case 'core-validation':
        throw new CoreValidationError({ title: ['Bad title.'], __all__: ['Bad object.'] })
      case 'does-not-exist':
        return Post.objects.get({ pk: 123456 })
      case 'custom':
        throw new ServiceUnavailable()
      case 'notfound':
        throw new NotFound()
      case 'boom':
        throw new Error('boom')
      case 'raw':
        return new Response('raw body', { status: 202, headers: { 'content-type': 'text/plain' } })
      case 'undefined':
        return undefined
      default:
        return null
    }
  }
}

class UploadSerializer extends Serializer {
  title = new CharField()
  attachment = new FileField()
  picture = new ImageField({ required: false })
  labels = new ListField({ child: new CharField(), required: false })
}

class Upload extends APIView {
  async post(request: APIRequest) {
    const s = new UploadSerializer({ data: request.data })
    await s.isValid({ raiseException: true })
    const { attachment, picture, title, labels } = s.validatedData
    return {
      title,
      labels,
      file: { name: attachment.name, size: attachment.size, text: await attachment.text() },
      picture: picture ? picture.type : null,
      files: Object.keys(request.files),
    }
  }
}

class RawUpload extends APIView {
  override parserClasses = [FileUploadParser]
  async put(request: APIRequest) {
    const file = request.data.file as File
    return { name: file.name, size: file.size, type: file.type }
  }
}

const hello = apiView(['GET', 'POST'])(async (request) => {
  if (request.method === 'POST') return new APIResponse({ message: 'Got some data!', data: request.data })
  return { message: 'Hello, world!' }
})

const secret = apiView(['GET'], { permissionClasses: [IsAuthenticated] })(
  async function secretView(request, kwargs) {
    return { user: request.user.username, id: kwargs.id }
  },
)

class PostSerializer extends ModelSerializer {
  static Meta = { model: Post, fields: ['id', 'title', 'slug', 'author'] }
}

class PostList extends ListCreateAPIView {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
}

class PostDetail extends RetrieveUpdateDestroyAPIView {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  override lookupField = 'slug'
}

const urls = [
  path('echo/', Echo),
  path('json-only/', JsonOnly),
  path('raise/', Raiser),
  path('upload/', Upload),
  path('raw-upload/<filename>/', RawUpload),
  path('hello/', hello),
  path('secret/<int:id>/', secret),
  path('posts/', PostList),
  path('posts/<slug:slug>/', PostDetail),
  path('plain/', () => {
    throw new NotFound('Plain view.')
  }),
]

describe('APIView, parsers and negotiation', () => {
  const api = useApi(() => ({ urls }))

  it('parses JSON, forms (repeated keys) and query strings', async () => {
    const get = await api.client.get('/echo/', { a: 1, tag: ['x', 'y'] })
    expect(get.data).toEqual({ method: 'GET', query: { a: '1', tag: 'x' }, all: ['x', 'y'] })
    const json = await api.client.post('/echo/', { nested: { a: [1, 2] } }, { format: 'json' })
    expect(json.status).toBe(201)
    expect(json.data).toEqual({ data: { nested: { a: [1, 2] } }, contentType: 'application/json' })
    const form = await api.client.post('/echo/', { a: '1', tag: ['x', 'y'] }, { format: 'form' })
    expect(form.data).toEqual({
      data: { a: '1', tag: ['x', 'y'] },
      contentType: 'application/x-www-form-urlencoded',
    })
    const multi = await api.client.post('/echo/', { a: '1' }, { format: 'multipart' })
    expect(multi.data).toEqual({ data: { a: '1' }, contentType: 'multipart/form-data' })
  })

  it('reports parse errors, unsupported media types and unacceptable renderers', async () => {
    const bad = await api.client.client.post('/echo/', {
      body: '{nope',
      headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).detail).toMatch(/^JSON parse error - /)
    const text = await api.client.client.post('/json-only/', {
      body: 'hi',
      headers: { 'content-type': 'text/plain' },
    })
    expect(text.status).toBe(415)
    expect(await text.json()).toEqual({ detail: 'Unsupported media type "text/plain" in request.' })
    const xml = await api.client.get('/echo/', undefined, { headers: { Accept: 'application/xml' } })
    expect(xml.status).toBe(406)
    expect(xml.data).toEqual({ detail: 'Could not satisfy the request Accept header.' })
    const fmt = await api.client.get('/echo/', { format: 'xml' })
    expect(fmt.status).toBe(404)
    const pretty = await api.client.get('/echo/', undefined, {
      headers: { Accept: 'application/json; indent=2' },
    })
    expect(await pretty.text()).toContain('\n  "method": "GET"')
    expect(pretty.headers.get('vary')).toBe('Accept')
    expect(pretty.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
    const head = await api.client.head('/echo/')
    expect(head.status).toBe(200)
  })

  it('maps core / ORM / REST errors to DRF responses', async () => {
    const r = (kind: string) => api.client.get('/raise/', { kind })
    expect((await r('http404')).data).toEqual({ detail: 'Nothing here.' })
    const denied = await r('denied')
    expect(denied.status).toBe(403)
    expect(denied.data).toEqual({ detail: 'Go away.' })
    const val = await r('core-validation')
    expect(val.status).toBe(400)
    expect(val.data).toEqual({ title: ['Bad title.'], nonFieldErrors: ['Bad object.'] })
    const dne = await r('does-not-exist')
    expect(dne.status).toBe(404)
    expect(dne.data).toEqual({ detail: 'Not found.' })
    const custom = await r('custom')
    expect(custom.status).toBe(503)
    expect(custom.data).toEqual({ detail: 'Service temporarily unavailable, try again later.' })
    const raw = await r('raw')
    expect(raw.status).toBe(202)
    expect(await raw.text()).toBe('raw body')
    expect(raw.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    const nul = await r('null')
    expect(nul.status).toBe(200)
    expect(await nul.text()).toBe('')
    const errSpy = console.error
    console.error = () => {}
    try {
      expect((await r('boom')).status).toBe(500)
      expect((await r('undefined')).status).toBe(500)
    } finally {
      console.error = errSpy
    }
    const plain = await api.client.get('/plain/')
    expect(plain.status).toBe(404)
    expect(plain.data).toEqual({ detail: 'Plain view.' })
  })

  it('uploads files (multipart and raw)', async () => {
    const res = await api.client.post(
      '/upload/',
      {
        title: 'Report',
        attachment: new File(['hello'], 'hello.txt', { type: 'text/plain' }),
        picture: new File([new Uint8Array([137, 80, 78, 71])], 'p.png', { type: 'image/png' }),
        labels: ['a', 'b'],
      },
      { format: 'multipart' },
    )
    expect(res.status).toBe(200)
    expect(res.data).toEqual({
      title: 'Report',
      labels: ['a', 'b'],
      file: { name: 'hello.txt', size: 5, text: 'hello' },
      picture: 'image/png',
      files: ['attachment', 'picture'],
    })
    const missing = await api.client.post('/upload/', { title: 'x' }, { format: 'multipart' })
    expect(missing.data).toEqual({ attachment: ['No file was submitted.'] })
    const raw = await api.client.client.put('/raw-upload/data.bin/', {
      body: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(await raw.json()).toEqual({ name: 'data.bin', size: 3, type: 'application/octet-stream' })
  })

  it('function views with apiView()', async () => {
    expect((await api.client.get('/hello/')).data).toEqual({ message: 'Hello, world!' })
    expect((await api.client.post('/hello/', { x: 1 })).data).toEqual({
      message: 'Got some data!',
      data: { x: 1 },
    })
    const put = await api.client.put('/hello/', {})
    expect(put.status).toBe(405)
    expect(put.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
    expect((await api.client.get('/secret/5/')).status).toBe(403)
    api.client.forceAuthenticate(fakeUser({ username: 'zoe' }))
    expect((await api.client.get('/secret/5/')).data).toEqual({ user: 'zoe', id: 5 })
    const options = await api.client.options('/secret/5/')
    expect(options.data).toMatchObject({ name: 'Secret', renders: ['application/json', 'text/html'] })
  })
})

describe.each(backends)('concrete generic views (%s)', (backend) => {
  const api = useApi(() => ({ backend, urls }))

  it('ListCreateAPIView and RetrieveUpdateDestroyAPIView with a slug lookup', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const created = await api.client.post('/posts/', { title: 'T', slug: 'my-post', author: ann.id })
    expect(created.status).toBe(201)
    expect((await api.client.get('/posts/')).data).toEqual([
      { id: created.data.id, title: 'T', slug: 'my-post', author: ann.id },
    ])
    expect((await api.client.get('/posts/my-post/')).data.title).toBe('T')
    expect((await api.client.patch('/posts/my-post/', { title: 'U' })).data.title).toBe('U')
    expect(
      (await api.client.put('/posts/my-post/', { title: 'V', slug: 'my-post', author: ann.id })).status,
    ).toBe(200)
    expect((await api.client.delete('/posts/my-post/')).status).toBe(204)
    expect((await api.client.get('/posts/my-post/')).status).toBe(404)
    expect((await api.client.post('/posts/my-post/', {})).status).toBe(405)
  })
})

describe('EXCEPTION_HANDLER setting', () => {
  it('uses a custom exception handler', async () => {
    const { client, db } = await makeApi({
      urls,
      rest: {
        EXCEPTION_HANDLER: (exc, ctx) => {
          const res = exceptionHandler(exc, ctx)
          if (res) res.data = { ...res.data, statusCode: res.status }
          return res
        },
      },
    })
    try {
      const res = await client.get('/raise/', { kind: 'notfound' })
      expect(res.data).toEqual({ detail: 'Not found.', statusCode: 404 })
    } finally {
      await db.teardown()
    }
  })
})

describe('xframeOptionsExempt', () => {
  class Framed extends APIView {
    static override xframeOptionsExempt = true
    async get() {
      return { ok: true }
    }
  }
  class Unframed extends APIView {
    async get() {
      return { ok: true }
    }
  }
  class FramedSet extends ViewSet {
    static override xframeOptionsExempt = true
    async list() {
      return new APIResponse([])
    }
  }

  it('honours static xframeOptionsExempt on APIView and ViewSet, and the wrapper', async () => {
    const { client, db } = await makeApi({
      urls: [
        path('framed/', Framed.asView()),
        path('unframed/', Unframed.asView()),
        path('framed-set/', FramedSet.asView({ get: 'list' })),
        path('wrapped/', xframeOptionsExempt(Unframed.asView())),
      ],
      settings: { MIDDLEWARE: [XFrameOptionsMiddleware] },
    })
    try {
      for (const url of ['/framed/', '/framed-set/', '/wrapped/']) {
        const res = await client.get(url)
        expect(res.status).toBe(200)
        expect(res.headers.get('x-frame-options')).toBeNull()
      }
      expect((await client.get('/unframed/')).headers.get('x-frame-options')).toBe('DENY')
    } finally {
      await db.teardown()
    }
  })
})

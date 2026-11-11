import { CsrfMiddleware, include, path, setUser } from '@ghuri/core'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  type APIRequest,
  APIView,
  type AuthenticationClass,
  AuthenticationFailed,
  type BaseAuthentication,
  BasePermission,
  DefaultRouter,
  IsAdminUser,
  IsAuthenticated,
  IsAuthenticatedOrReadOnly,
  MiddlewareAuthentication,
  ModelPermissions,
  ModelPermissionsOrAnonReadOnly,
  ModelSerializer,
  ModelViewSet,
  ObjectPermissions,
  SAFE_METHODS,
} from '../src/index'
import { backends, fakeUser, makeApi, useApi } from './helpers'
import { Member, Post, Tag } from './models'

const ADMIN = fakeUser({ pk: 1, username: 'admin', isStaff: true })
const BOB = fakeUser({ pk: 2, username: 'bob' })

class FakeTokenAuthentication implements BaseAuthentication {
  async authenticate(c: Context) {
    const header = c.req.header('authorization')
    if (!header?.startsWith('Token ')) return null
    const token = header.slice(6)
    if (token === 'admin') return [ADMIN, token] as [typeof ADMIN, string]
    if (token === 'bob') return [BOB, token] as [typeof BOB, string]
    throw new AuthenticationFailed('Invalid token.')
  }
  authenticateHeader() {
    return 'Token'
  }
}

class HeaderlessAuthentication implements BaseAuthentication {
  async authenticate() {
    return null
  }
}

class ReadOnly extends BasePermission {
  override hasPermission(request: APIRequest) {
    return SAFE_METHODS.includes(request.method)
  }
}

class IsAuthorOrReadOnly extends BasePermission {
  override message = 'Only the author may do that.'
  override async hasObjectPermission(request: APIRequest, _view: unknown, obj: Post) {
    if (SAFE_METHODS.includes(request.method)) return true
    const author = await obj.author
    return author.username === request.user.username
  }
}

class WhoAmI extends APIView {
  override authenticationClasses: AuthenticationClass[] = [FakeTokenAuthentication]
  override permissionClasses = [IsAuthenticated]
  async get(request: APIRequest) {
    return {
      username: request.user.username,
      auth: request.auth,
      authenticator: request.successfulAuthenticator?.constructor.name,
    }
  }
}

class Headerless extends WhoAmI {
  override authenticationClasses = [HeaderlessAuthentication]
}

class Composed extends APIView {
  override authenticationClasses = [FakeTokenAuthentication]
  override permissionClasses = [IsAdminUser.or(ReadOnly)]
  async get() {
    return { ok: true }
  }
  async post() {
    return { created: true }
  }
}

class NotAdmin extends APIView {
  override authenticationClasses = [FakeTokenAuthentication]
  override permissionClasses = [IsAuthenticated.and(IsAdminUser.not())]
  async get() {
    return { ok: true }
  }
}

class SessionView extends APIView {
  override authenticationClasses = [MiddlewareAuthentication]
  override permissionClasses = [IsAuthenticated]
  async get(request: APIRequest) {
    return { username: request.user.username }
  }
  async post(request: APIRequest) {
    return { username: request.user.username, data: request.data }
  }
}

class PostSerializer extends ModelSerializer {
  static Meta = { model: Post, fields: ['id', 'title', 'slug'] }
}
class TagSerializer extends ModelSerializer {
  static Meta = { model: Tag, fields: ['id', 'name'] }
}

const router = new DefaultRouter()
router.register(
  'posts',
  class PostViewSet extends ModelViewSet {
    override authenticationClasses = [FakeTokenAuthentication]
    override permissionClasses = [IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly]
    queryset = Post.objects.all()
    serializerClass = PostSerializer
  },
)
router.register(
  'tags',
  class TagViewSet extends ModelViewSet {
    queryset = Tag.objects.all()
    serializerClass = TagSerializer
    override permissionClasses = [ModelPermissions]
  },
)
router.register(
  'public-tags',
  class PublicTagViewSet extends ModelViewSet {
    queryset = Tag.objects.all()
    serializerClass = TagSerializer
    override permissionClasses = [ModelPermissionsOrAnonReadOnly]
  },
  { basename: 'public-tag' },
)
router.register(
  'object-posts',
  class ObjectPostViewSet extends ModelViewSet {
    queryset = Post.objects.all()
    serializerClass = PostSerializer
    override permissionClasses = [ObjectPermissions]
  },
  { basename: 'object-post' },
)

const urls = [
  path('whoami/', WhoAmI),
  path('headerless/', Headerless),
  path('composed/', Composed),
  path('not-admin/', NotAdmin),
  path('session/', SessionView),
  path('api/', include(router.urls)),
]

const fakeSessionMiddleware = async (c: Context, next: () => Promise<void>) => {
  const name = c.req.header('x-session-user')
  if (name) setUser(c, fakeUser({ username: name }))
  await next()
}

describe.each(backends)('authentication & permissions (%s)', (backend) => {
  const api = useApi(() => ({ backend, urls, settings: { MIDDLEWARE: [fakeSessionMiddleware] } }))

  it('implements the authentication contract (401 + WWW-Authenticate, 403 without header)', async () => {
    const anon = await api.client.get('/whoami/')
    expect(anon.status).toBe(401)
    expect(anon.headers.get('www-authenticate')).toBe('Token')
    expect(anon.data).toEqual({ detail: 'Authentication credentials were not provided.' })
    const bad = await api.client.get('/whoami/', undefined, { headers: { Authorization: 'Token nope' } })
    expect(bad.status).toBe(401)
    expect(bad.data).toEqual({ detail: 'Invalid token.' })
    api.client.credentials({ Authorization: 'Token bob' })
    const ok = await api.client.get('/whoami/')
    expect(ok.status).toBe(200)
    expect(ok.data).toEqual({ username: 'bob', auth: 'bob', authenticator: 'FakeTokenAuthentication' })
    const headerless = await api.client.get('/headerless/')
    expect(headerless.status).toBe(403)
    expect(headerless.data).toEqual({ detail: 'Authentication credentials were not provided.' })
  })

  it('forceAuthenticate bypasses authentication classes', async () => {
    api.client.forceAuthenticate(fakeUser({ username: 'forced' }), 'tok')
    const res = await api.client.get('/whoami/')
    expect(res.data).toEqual({ username: 'forced', auth: 'tok', authenticator: 'ForcedAuthentication' })
    api.client.forceAuthenticate(null)
    expect((await api.client.get('/whoami/')).status).toBe(401)
  })

  it('composes permissions with or / and / not', async () => {
    expect((await api.client.get('/composed/')).status).toBe(200)
    expect((await api.client.post('/composed/', {})).status).toBe(401)
    api.client.credentials({ Authorization: 'Token bob' })
    const denied = await api.client.post('/composed/', {})
    expect(denied.status).toBe(403)
    expect(denied.data).toEqual({ detail: 'You do not have permission to perform this action.' })
    expect((await api.client.get('/not-admin/')).status).toBe(200)
    api.client.credentials({ Authorization: 'Token admin' })
    expect((await api.client.post('/composed/', {})).status).toBe(200)
    expect((await api.client.get('/not-admin/')).status).toBe(403)
  })

  it('checks object permissions in getObject()', async () => {
    const bob = await Member.objects.create({ username: 'bob' })
    const ann = await Member.objects.create({ username: 'ann' })
    const bobs = await Post.objects.create({ title: 'B', slug: 'b', author: bob })
    const anns = await Post.objects.create({ title: 'A', slug: 'a', author: ann })
    expect((await api.client.get(`/api/posts/${anns.id}/`)).status).toBe(200)
    expect((await api.client.patch(`/api/posts/${bobs.id}/`, { title: 'x' })).status).toBe(401)
    api.client.credentials({ Authorization: 'Token bob' })
    const mine = await api.client.patch(`/api/posts/${bobs.id}/`, { title: 'Mine' })
    expect(mine.status).toBe(200)
    const theirs = await api.client.patch(`/api/posts/${anns.id}/`, { title: 'Theirs' })
    expect(theirs.status).toBe(403)
    expect(theirs.data).toEqual({ detail: 'Only the author may do that.' })
    expect((await api.client.delete(`/api/posts/${anns.id}/`)).status).toBe(403)
  })

  it('ModelPermissions maps methods to model permissions', async () => {
    const tag = await Tag.objects.create({ name: 'js' })
    expect((await api.client.get('/api/tags/')).status).toBe(403)
    api.client.forceAuthenticate(fakeUser({ perms: ['blog.add_tag'] }))
    expect((await api.client.get('/api/tags/')).status).toBe(200)
    expect((await api.client.post('/api/tags/', { name: 'ts' })).status).toBe(201)
    expect((await api.client.delete(`/api/tags/${tag.id}/`)).status).toBe(403)
    api.client.forceAuthenticate(fakeUser({ perms: ['blog.delete_tag'] }))
    expect((await api.client.delete(`/api/tags/${tag.id}/`)).status).toBe(204)
    api.client.forceAuthenticate(null)
    expect((await api.client.get('/api/public-tags/')).status).toBe(200)
    expect((await api.client.post('/api/public-tags/', { name: 'x' })).status).toBe(403)
  })

  it('ObjectPermissions asks hasPerm(perm, obj)', async () => {
    const bob = await Member.objects.create({ username: 'bob' })
    const p1 = await Post.objects.create({ title: 'One', slug: 'one', author: bob })
    const p2 = await Post.objects.create({ title: 'Two', slug: 'two', author: bob })
    api.client.forceAuthenticate(
      fakeUser({
        perms: ['blog.change_post'],
        objectPerms: (perm, obj: any) => perm === 'blog.change_post' && obj.id === p1.id,
      }),
    )
    expect((await api.client.patch(`/api/object-posts/${p1.id}/`, { title: 'Uno' })).status).toBe(200)
    expect((await api.client.patch(`/api/object-posts/${p2.id}/`, { title: 'Dos' })).status).toBe(403)
  })

  it('MiddlewareAuthentication uses the middleware user and enforces CSRF', async () => {
    expect((await api.client.get('/session/')).status).toBe(403)
    const headers = { 'x-session-user': 'carol' }
    const res = await api.client.get('/session/', undefined, { headers })
    expect(res.data).toEqual({ username: 'carol' })
    const post = await api.client.post('/session/', { a: 1 }, { headers })
    expect(post.status).toBe(200)
    expect(post.data).toEqual({ username: 'carol', data: { a: 1 } })
    const noCsrf = await api.client.post('/session/', { a: 1 }, { headers, csrf: false })
    expect(noCsrf.status).toBe(403)
    expect(noCsrf.data.detail).toMatch(/^CSRF Failed: /)
  })
})

describe('CSRF', () => {
  it('API views are CSRF-exempt under CsrfMiddleware; plain views are not', async () => {
    const { client, db } = await makeApi({
      urls: [...urls, path('plain-post/', (c) => c.json({ ok: true }))],
      settings: { MIDDLEWARE: [CsrfMiddleware] },
    })
    try {
      const api = await client.post(
        '/composed/',
        {},
        { headers: { Authorization: 'Token admin' }, csrf: false },
      )
      expect(api.status).toBe(200)
      const plain = await client.post('/plain-post/', {}, { csrf: false })
      expect(plain.status).toBe(403)
    } finally {
      await db.teardown()
    }
  })
})

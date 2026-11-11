import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  type APIRequest,
  APIResponse,
  action,
  CharField,
  DefaultRouter,
  IsAdminUser,
  ModelSerializer,
  ModelViewSet,
  ReadOnlyModelViewSet,
  SerializerMethodField,
  SimpleRouter,
  SlugRelatedField,
  status,
  ValidationError,
} from '../src/index'
import { backends, fakeUser, useApi } from './helpers'
import { Comment, Member, Post, Tag } from './models'

class TagSerializer extends ModelSerializer<Tag> {
  static Meta = { model: Tag, fields: ['id', 'name'] }
}

class MemberSerializer extends ModelSerializer<Member> {
  static Meta = { model: Member, fields: ['id', 'username'] }
}

class PostSerializer extends ModelSerializer<Post> {
  static Meta = {
    model: Post,
    fields: [
      'id',
      'title',
      'slug',
      'body',
      'published',
      'rating',
      'status',
      'views',
      'author',
      'tags',
      'createdAt',
    ],
    readOnlyFields: ['author'],
  }
  authorName = new CharField({ source: 'author.username', readOnly: true })
  tagNames = new SlugRelatedField({ source: 'tags', many: true, readOnly: true, slugField: 'name' })
  commentCount = new SerializerMethodField()

  async getCommentCount(obj: Post): Promise<number> {
    return Comment.objects.filter({ post: obj.pk }).count()
  }

  validateTitle(value: string): string {
    if (value.includes('spam')) throw new ValidationError('No spam')
    return value
  }

  validate(attrs: any) {
    if (attrs.status === 'live' && !attrs.body) throw new ValidationError('Live posts need a body.')
    return attrs
  }
}

class NestedPostSerializer extends ModelSerializer<Post> {
  static Meta = { model: Post, fields: ['id', 'title', 'author', 'tags'] }
  author = new MemberSerializer({ readOnly: true })
  tags = new TagSerializer({ many: true, readOnly: true })
}

class PostViewSet extends ModelViewSet<Post> {
  queryset = Post.objects.all()
  serializerClass = PostSerializer

  override async performCreate(serializer: any): Promise<void> {
    const author = await Member.objects.get({ username: this.request.user.username })
    await serializer.save({ author })
  }

  @action({ detail: true, methods: ['post'] })
  async publish(_request: APIRequest) {
    const post = await this.getObject()
    post.published = true
    await post.save()
    return new APIResponse({ status: 'published', id: post.id })
  }

  @action({ detail: false, methods: ['get'], urlPath: 'drafts', permissionClasses: [IsAdminUser] })
  async draftPosts(_request: APIRequest) {
    const drafts = await this.getQueryset().filter({ published: false })
    const s = this.getSerializer({ instance: drafts, many: true })
    return s.getData()
  }

  async archive(_request: APIRequest) {
    return { action: this.action, detail: this.detail }
  }
  static actions = { archive: action({ detail: true, methods: ['post', 'delete'], urlPath: 'archive' }) }
}

class NestedPostViewSet extends ReadOnlyModelViewSet<Post> {
  queryset = Post.objects.all()
  serializerClass = NestedPostSerializer
}

const router = new DefaultRouter()
router.register('posts', PostViewSet)
router.register('nested-posts', NestedPostViewSet, { basename: 'nested-post' })
const plain = new SimpleRouter({ trailingSlash: false })
plain.register(
  'tags',
  class TagViewSet extends ModelViewSet {
    queryset = Tag.objects.all()
    serializerClass = TagSerializer
  },
)

const urls = [path('api/', include(router.urls)), path('plain/', include(plain.urls, { namespace: 'plain' }))]

describe.each(backends)('ModelViewSet end-to-end (%s)', (backend) => {
  const api = useApi(() => ({ urls, backend }))

  async function seed() {
    const alice = await Member.objects.create({ username: 'alice' })
    const bob = await Member.objects.create({ username: 'bob' })
    const js = await Tag.objects.create({ name: 'js' })
    const ts = await Tag.objects.create({ name: 'ts' })
    const p1 = await Post.objects.create({ title: 'Hello', slug: 'hello', author: alice, body: 'b' })
    await p1.tags.set([js, ts])
    const p2 = await Post.objects.create({ title: 'Second', slug: 'second', author: bob, published: true })
    return { alice, bob, js, ts, p1, p2 }
  }

  it('lists, with related and computed fields', async () => {
    const { p1, js, ts } = await seed()
    await Comment.objects.create({ post: p1, rank: 1, text: 'c1' })
    const res = await api.client.get('/api/posts/')
    expect(res.status).toBe(200)
    expect(res.data).toHaveLength(2)
    const first = res.data[0]
    expect(first).toMatchObject({
      id: p1.id,
      title: 'Hello',
      slug: 'hello',
      body: 'b',
      published: false,
      rating: null,
      status: 'draft',
      views: 0,
      author: p1.authorId,
      authorName: 'alice',
      tags: [js.id, ts.id],
      tagNames: ['js', 'ts'],
      commentCount: 1,
    })
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  })

  it('creates with M2M, returns 201, then retrieves', async () => {
    const { js } = await seed()
    api.client.forceAuthenticate(fakeUser({ username: 'alice' }))
    const res = await api.client.post('/api/posts/', {
      title: 'New post',
      slug: 'new-post',
      tags: [js.id],
      rating: '4.5',
      author: 999,
    })
    expect(res.status).toBe(status.HTTP_201_CREATED)
    expect(res.data).toMatchObject({ title: 'New post', rating: '4.50', tags: [js.id], authorName: 'alice' })
    const created = await Post.objects.get({ slug: 'new-post' })
    expect(await created.tags.count()).toBe(1)
    const detail = await api.client.get(`/api/posts/${created.id}/`)
    expect(detail.status).toBe(200)
    expect(detail.data.title).toBe('New post')
  })

  it('returns DRF-shaped validation errors', async () => {
    await seed()
    api.client.forceAuthenticate(fakeUser({ username: 'alice' }))
    const res = await api.client.post('/api/posts/', {
      title: 'spam here',
      slug: 'hello',
      rating: 'abc',
      status: 'nope',
      tags: [12345],
    })
    expect(res.status).toBe(400)
    expect(res.data).toEqual({
      title: ['No spam'],
      slug: ['Post with this Slug already exists.'],
      rating: ['A valid number is required.'],
      status: ['"nope" is not a valid choice.'],
      tags: ['Invalid pk "12345" - object does not exist.'],
    })
    const missing = await api.client.post('/api/posts/', {})
    expect(missing.data).toEqual({ title: ['This field is required.'], slug: ['This field is required.'] })
    const nonField = await api.client.post('/api/posts/', { title: 'T', slug: 't', status: 'live' })
    expect(nonField.status).toBe(400)
    expect(nonField.data).toEqual({ nonFieldErrors: ['Live posts need a body.'] })
  })

  it('updates (PUT) and partially updates (PATCH)', async () => {
    const { p1, ts } = await seed()
    const put = await api.client.put(`/api/posts/${p1.id}/`, {
      title: 'Updated',
      slug: 'hello',
      tags: [ts.id],
    })
    expect(put.status).toBe(200)
    expect(put.data).toMatchObject({ title: 'Updated', tags: [ts.id], body: 'b' })
    const bad = await api.client.put(`/api/posts/${p1.id}/`, { title: 'Only title' })
    expect(bad.status).toBe(400)
    expect(bad.data).toEqual({ slug: ['This field is required.'] })
    const patch = await api.client.patch(`/api/posts/${p1.id}/`, { views: 7 })
    expect(patch.status).toBe(200)
    expect(patch.data).toMatchObject({ title: 'Updated', views: 7 })
    const negative = await api.client.patch(`/api/posts/${p1.id}/`, { views: -1 })
    expect(negative.data).toEqual({ views: ['Ensure this value is greater than or equal to 0.'] })
    expect((await Post.objects.get({ pk: p1.id })).views).toBe(7)
  })

  it('destroys and 404s', async () => {
    const { p1 } = await seed()
    const res = await api.client.delete(`/api/posts/${p1.id}/`)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    const missing = await api.client.get(`/api/posts/${p1.id}/`)
    expect(missing.status).toBe(404)
    expect(missing.data).toEqual({ detail: 'No Post matches the given query.' })
    const junk = await api.client.get('/api/posts/abc/')
    expect(junk.status).toBe(404)
  })

  it('runs custom actions (detail, list, static map) with per-action permissions', async () => {
    const { p1 } = await seed()
    const pub = await api.client.post(`/api/posts/${p1.id}/publish/`)
    expect(pub.status).toBe(200)
    expect(pub.data).toEqual({ status: 'published', id: p1.id })
    expect((await Post.objects.get({ pk: p1.id })).published).toBe(true)

    const anon = await api.client.get('/api/posts/drafts/')
    expect(anon.status).toBe(403)
    api.client.forceAuthenticate(fakeUser({ isStaff: true }))
    const drafts = await api.client.get('/api/posts/drafts/')
    expect(drafts.status).toBe(200)
    expect(drafts.data).toEqual([])

    const archive = await api.client.delete(`/api/posts/${p1.id}/archive/`)
    expect(archive.data).toEqual({ action: 'archive', detail: true })
    const wrong = await api.client.get(`/api/posts/${p1.id}/archive/`)
    expect(wrong.status).toBe(405)
    expect(wrong.data).toEqual({ detail: 'Method "GET" not allowed.' })
    expect(wrong.headers.get('allow')).toBe('POST, DELETE, OPTIONS')
  })

  it('serializes nested serializers', async () => {
    const { p1, alice } = await seed()
    const res = await api.client.get(`/api/nested-posts/${p1.id}/`)
    expect(res.data).toEqual({
      id: p1.id,
      title: 'Hello',
      author: { id: alice.id, username: 'alice' },
      tags: [
        { id: expect.any(Number), name: 'js' },
        { id: expect.any(Number), name: 'ts' },
      ],
    })
    const post = await api.client.post('/api/nested-posts/', {})
    expect(post.status).toBe(405)
  })

  it('serves the API root, format suffixes, OPTIONS and namespaced routers', async () => {
    const root = await api.client.get('/api/')
    expect(root.data).toEqual({
      posts: 'http://testserver/api/posts/',
      'nested-posts': 'http://testserver/api/nested-posts/',
    })
    await seed()
    const json = await api.client.get('/api/posts.json')
    expect(json.status).toBe(200)
    expect(json.headers.get('content-type')).toContain('application/json')
    const html = await api.client.get('/api/posts/', undefined, { headers: { Accept: 'text/html' } })
    expect(html.headers.get('content-type')).toContain('text/html')
    expect(await html.text()).toContain('Post List')
    const opts = await api.client.options('/api/posts/')
    expect(opts.status).toBe(200)
    expect(opts.data.name).toBe('Post List')
    expect(opts.data.actions.POST.title).toMatchObject({
      type: 'string',
      required: true,
      maxLength: 100,
      label: 'Title',
    })
    expect(opts.data.actions.POST.status.choices).toEqual([
      { value: 'draft', displayName: 'Draft' },
      { value: 'live', displayName: 'Live' },
    ])
    const tags = await api.client.get('/plain/tags')
    expect(tags.status).toBe(200)
    expect(tags.data.map((t: any) => t.name)).toEqual(['js', 'ts'])
  })
})

import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  type APIRequest,
  action,
  DefaultRouter,
  FieldFilter,
  ModelSerializer,
  ModelViewSet,
  PageNumberPagination,
  SearchFilter,
} from '../src/index'
import { fakeUser, useApi } from './helpers'
import { Member, Post, Tag } from './models'

class PostSerializer extends ModelSerializer {
  static Meta = { model: Post, fields: ['id', 'title', 'slug', 'author', 'tags', 'published'] }
}

class Pages extends PageNumberPagination {
  override pageSize = 2
}

class PostViewSet extends ModelViewSet {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  override paginationClass = Pages
  override filterBackends = [SearchFilter, FieldFilter]
  override searchFields = ['title']
  override filtersetFields = ['published']

  @action({ detail: true, methods: ['post'] })
  async publish(_request: APIRequest) {
    const post = await this.getObject()
    post.published = true
    await post.save()
    return { published: true }
  }
}

const router = new DefaultRouter()
router.register('posts', PostViewSet)

describe('Cloudflare D1 smoke test', () => {
  const api = useApi(() => ({ backend: 'd1', urls: [path('api/', include(router.urls))] }))

  it('runs a ModelViewSet against D1', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const js = await Tag.objects.create({ name: 'js' })
    api.client.forceAuthenticate(fakeUser())
    const created = await api.client.post('/api/posts/', {
      title: 'On D1',
      slug: 'd1',
      author: ann.id,
      tags: [js.id],
    })
    expect(created.status).toBe(201)
    expect(created.data).toMatchObject({ title: 'On D1', tags: [js.id], published: false })
    for (const n of [2, 3])
      await api.client.post('/api/posts/', { title: `Post ${n}`, slug: `p${n}`, author: ann.id })
    const page = await api.client.get('/api/posts/')
    expect(page.data.count).toBe(3)
    expect(page.data.results).toHaveLength(2)
    expect(page.data.next).toBe('http://testserver/api/posts/?page=2')
    const pub = await api.client.post(`/api/posts/${created.data.id}/publish/`)
    expect(pub.data).toEqual({ published: true })
    const filtered = await api.client.get('/api/posts/', { published: 'true', search: 'd1' })
    expect(filtered.data.results.map((p: any) => p.slug)).toEqual(['d1'])
    expect((await api.client.patch(`/api/posts/${created.data.id}/`, { title: 'Edited' })).data.title).toBe(
      'Edited',
    )
    expect((await api.client.delete(`/api/posts/${created.data.id}/`)).status).toBe(204)
    expect((await api.client.get(`/api/posts/${created.data.id}/`)).status).toBe(404)
  })
})

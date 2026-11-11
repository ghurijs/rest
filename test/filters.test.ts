import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  FieldFilter,
  ModelSerializer,
  OrderingFilter,
  ReadOnlyModelViewSet,
  SearchFilter,
  SimpleRouter,
} from '../src/index'
import { backends, useApi } from './helpers'
import { Member, Post, Tag } from './models'

class PostSerializer extends ModelSerializer {
  static Meta = { model: Post, fields: ['id', 'title', 'slug', 'views', 'published', 'createdAt'] }
}

class PostViewSet extends ReadOnlyModelViewSet {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  override filterBackends = [SearchFilter, OrderingFilter, FieldFilter]
  override searchFields = ['title', '=slug', '^body', 'tags__name', 'author__username']
  override orderingFields = ['title', 'views']
  override ordering = ['-views']
  override filtersetFields = {
    published: ['exact'],
    views: ['exact', 'gte', 'lt', 'in', 'range'],
    title: ['icontains'],
    author: ['exact'],
    author__username: ['exact'],
    rating: ['isnull'],
    createdAt: ['gte', 'year'],
  }
}

class DefaultOrdering extends ReadOnlyModelViewSet {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  override filterBackends = [OrderingFilter]
}

const router = new SimpleRouter()
router.register('posts', PostViewSet)
router.register('default-ordering', DefaultOrdering, { basename: 'default-ordering' })

const titles = (res: any) => res.data.map((p: any) => p.title)

describe.each(backends)('filter backends (%s)', (backend) => {
  const api = useApi(() => ({ backend, urls: [path('api/', include(router.urls))] }))

  async function seed() {
    const ann = await Member.objects.create({ username: 'ann' })
    const bob = await Member.objects.create({ username: 'bob' })
    const js = await Tag.objects.create({ name: 'javascript' })
    const py = await Tag.objects.create({ name: 'python' })
    const a = await Post.objects.create({
      title: 'Ghuri intro',
      slug: 'intro',
      body: 'Hello world',
      views: 10,
      published: true,
      author: ann,
    })
    const b = await Post.objects.create({
      title: 'Deep dive',
      slug: 'deep',
      body: 'Routers',
      views: 30,
      author: ann,
      rating: '4.00',
    })
    const c = await Post.objects.create({
      title: 'Python tips',
      slug: 'tips',
      body: 'Hello snakes',
      views: 20,
      published: true,
      author: bob,
    })
    await a.tags.set([js, py])
    await b.tags.set([js])
    await c.tags.set([py])
    return { ann, bob, a, b, c }
  }

  it('SearchFilter: terms AND-ed, fields OR-ed, prefixes', async () => {
    await seed()
    expect(titles(await api.client.get('/api/posts/', { search: 'ghuri' }))).toEqual(['Ghuri intro'])
    expect(titles(await api.client.get('/api/posts/', { search: 'hello' }))).toEqual([
      'Python tips',
      'Ghuri intro',
    ])
    expect(titles(await api.client.get('/api/posts/', { search: 'tips hello' }))).toEqual(['Python tips'])
    expect(titles(await api.client.get('/api/posts/', { search: 'deep' }))).toEqual(['Deep dive'])
    expect(titles(await api.client.get('/api/posts/', { search: 'dee' }))).toEqual(['Deep dive'])
    expect(titles(await api.client.get('/api/posts/', { search: 'ntro' }))).toEqual(['Ghuri intro'])
    expect(titles(await api.client.get('/api/posts/', { search: 'world' }))).toEqual([])
    expect(titles(await api.client.get('/api/posts/', { search: 'script' }))).toEqual([
      'Deep dive',
      'Ghuri intro',
    ])
    expect(titles(await api.client.get('/api/posts/', { search: 'bob' }))).toEqual(['Python tips'])
    expect(titles(await api.client.get('/api/posts/', { search: '"python tips"' }))).toEqual(['Python tips'])
  })

  it('OrderingFilter validates fields and falls back to the default', async () => {
    await seed()
    expect(titles(await api.client.get('/api/posts/'))).toEqual(['Deep dive', 'Python tips', 'Ghuri intro'])
    expect(titles(await api.client.get('/api/posts/', { ordering: 'title' }))).toEqual([
      'Deep dive',
      'Ghuri intro',
      'Python tips',
    ])
    expect(titles(await api.client.get('/api/posts/', { ordering: '-title' }))).toEqual([
      'Python tips',
      'Ghuri intro',
      'Deep dive',
    ])
    expect(titles(await api.client.get('/api/posts/', { ordering: 'slug' }))).toEqual([
      'Deep dive',
      'Python tips',
      'Ghuri intro',
    ])
    expect(titles(await api.client.get('/api/default-ordering/', { ordering: '-views' }))).toEqual([
      'Deep dive',
      'Python tips',
      'Ghuri intro',
    ])
    expect(titles(await api.client.get('/api/default-ordering/', { ordering: 'body' }))).toEqual([
      'Ghuri intro',
      'Deep dive',
      'Python tips',
    ])
  })

  it('FieldFilter converts values and supports lookups', async () => {
    const { ann } = await seed()
    expect(titles(await api.client.get('/api/posts/', { published: 'true' }))).toEqual([
      'Python tips',
      'Ghuri intro',
    ])
    expect(titles(await api.client.get('/api/posts/', { published: 'false' }))).toEqual(['Deep dive'])
    expect(titles(await api.client.get('/api/posts/', { views__gte: 20 }))).toEqual([
      'Deep dive',
      'Python tips',
    ])
    expect(titles(await api.client.get('/api/posts/', { views__lt: 20 }))).toEqual(['Ghuri intro'])
    expect(titles(await api.client.get('/api/posts/', { views__in: '10,30' }))).toEqual([
      'Deep dive',
      'Ghuri intro',
    ])
    expect(titles(await api.client.get('/api/posts/', { views__range: '15,25' }))).toEqual(['Python tips'])
    expect(titles(await api.client.get('/api/posts/', { title__icontains: 'TIPS' }))).toEqual(['Python tips'])
    expect(titles(await api.client.get('/api/posts/', { author: ann.id }))).toEqual([
      'Deep dive',
      'Ghuri intro',
    ])
    expect(titles(await api.client.get('/api/posts/', { author__username: 'bob' }))).toEqual(['Python tips'])
    expect(titles(await api.client.get('/api/posts/', { rating__isnull: 'false' }))).toEqual(['Deep dive'])
    const year = new Date().getUTCFullYear()
    expect(titles(await api.client.get('/api/posts/', { createdAt__year: year }))).toHaveLength(3)
    expect(titles(await api.client.get('/api/posts/', { createdAt__gte: '2000-01-01' }))).toHaveLength(3)
    expect(titles(await api.client.get('/api/posts/', { views__gt: 1, slug: 'x' }))).toHaveLength(3)
    const bad = await api.client.get('/api/posts/', { views__gte: 'lots', published: 'perhaps' })
    expect(bad.status).toBe(400)
    expect(bad.data).toEqual({ views__gte: [expect.any(String)], published: ['Enter a valid boolean.'] })
  })
})

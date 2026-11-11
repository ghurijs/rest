import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  CursorPagination,
  LimitOffsetPagination,
  ModelSerializer,
  OrderingFilter,
  PageNumberPagination,
  ReadOnlyModelViewSet,
  SimpleRouter,
} from '../src/index'
import { backends, useApi } from './helpers'
import { Member, Post } from './models'

class PostSerializer extends ModelSerializer {
  static Meta = { model: Post, fields: ['id', 'title', 'views'] }
}

class SmallPages extends PageNumberPagination {
  override pageSize = 2
  override pageSizeQueryParam = 'size'
  override maxPageSize = 3
}

class ByViewsCursor extends CursorPagination {
  override pageSize = 2
  override ordering = ['views', 'id']
}

class IdCursor extends CursorPagination {
  override pageSize = 3
  override ordering = '-id'
}

function viewset(paginationClass: any, extra: Record<string, unknown> = {}) {
  return class extends ReadOnlyModelViewSet {
    queryset = Post.objects.all()
    serializerClass = PostSerializer
    override paginationClass = paginationClass
    constructor() {
      super()
      Object.assign(this, extra)
    }
  }
}

const router = new SimpleRouter()
router.register('pages', viewset(SmallPages), { basename: 'pages' })
router.register('default-pages', viewset(PageNumberPagination), { basename: 'default-pages' })
router.register('limit', viewset(LimitOffsetPagination), { basename: 'limit' })
router.register('cursor', viewset(ByViewsCursor), { basename: 'cursor' })
router.register('id-cursor', viewset(IdCursor), { basename: 'id-cursor' })
router.register(
  'ordered-cursor',
  viewset(IdCursor, { filterBackends: [OrderingFilter], orderingFields: ['title'] }),
  {
    basename: 'ordered-cursor',
  },
)
router.register('unpaginated', viewset(null), { basename: 'unpaginated' })

describe.each(backends)('pagination (%s)', (backend) => {
  const api = useApi(() => ({ backend, urls: [path('api/', include(router.urls))], rest: { PAGE_SIZE: 4 } }))

  async function seed(n: number, views: (i: number) => number = (i) => i) {
    const author = await Member.objects.create({ username: 'a' })
    for (let i = 1; i <= n; i++)
      await Post.objects.create({ title: `P${i}`, slug: `p${i}`, author, views: views(i) })
  }

  it('PageNumberPagination', async () => {
    await seed(5)
    const p1 = await api.client.get('/api/pages/')
    expect(p1.data).toEqual({
      count: 5,
      next: 'http://testserver/api/pages/?page=2',
      previous: null,
      results: [expect.objectContaining({ title: 'P1' }), expect.objectContaining({ title: 'P2' })],
    })
    const p2 = await api.client.get(p1.data.next)
    expect(p2.data.previous).toBe('http://testserver/api/pages/')
    expect(p2.data.next).toBe('http://testserver/api/pages/?page=3')
    const last = await api.client.get('/api/pages/', { page: 'last' })
    expect(last.data.results.map((r: any) => r.title)).toEqual(['P5'])
    expect(last.data.next).toBeNull()
    expect(last.data.previous).toBe('http://testserver/api/pages/?page=2')
    const sized = await api.client.get('/api/pages/', { size: 10 })
    expect(sized.data.results).toHaveLength(3)
    const invalid = await api.client.get('/api/pages/', { page: 9 })
    expect(invalid.status).toBe(404)
    expect(invalid.data).toEqual({ detail: 'Invalid page.' })
    expect((await api.client.get('/api/pages/', { page: 'x' })).status).toBe(404)
    const defaults = await api.client.get('/api/default-pages/')
    expect(defaults.data.results).toHaveLength(4)
  })

  it('LimitOffsetPagination', async () => {
    await seed(5)
    const first = await api.client.get('/api/limit/', { limit: 2 })
    expect(first.data).toMatchObject({
      count: 5,
      previous: null,
      next: 'http://testserver/api/limit/?limit=2&offset=2',
    })
    expect(first.data.results.map((r: any) => r.title)).toEqual(['P1', 'P2'])
    const second = await api.client.get(first.data.next)
    expect(second.data.previous).toBe('http://testserver/api/limit/?limit=2')
    const third = await api.client.get(second.data.next)
    expect(third.data.results.map((r: any) => r.title)).toEqual(['P5'])
    expect(third.data.next).toBeNull()
    expect(third.data.previous).toBe('http://testserver/api/limit/?limit=2&offset=2')
    const defaults = await api.client.get('/api/limit/')
    expect(defaults.data.results).toHaveLength(4)
    expect((await api.client.get('/api/limit/', { offset: 50 })).data.results).toEqual([])
  })

  it('CursorPagination walks forward and back over duplicate positions', async () => {
    const views = [1, 1, 1, 2, 2, 3, 4]
    await seed(7, (i) => views[i - 1])
    const seen: string[] = []
    let url: string | null = '/api/cursor/'
    const pages: any[] = []
    while (url) {
      const res = await api.client.get(url)
      expect(res.status).toBe(200)
      expect(Object.keys(res.data)).toEqual(['next', 'previous', 'results'])
      pages.push(res.data)
      seen.push(...res.data.results.map((r: any) => r.title))
      url = res.data.next
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(pages[0].previous).toBeNull()
    const back: string[] = []
    let prev: string | null = pages[pages.length - 1].previous
    while (prev) {
      const res = await api.client.get(prev)
      back.unshift(...res.data.results.map((r: any) => r.title))
      prev = res.data.previous
    }
    expect([...back, ...pages[pages.length - 1].results.map((r: any) => r.title)]).toEqual(seen)
  })

  it('CursorPagination uses OrderingFilter ordering and rejects bad cursors', async () => {
    await seed(5)
    const desc = await api.client.get('/api/id-cursor/')
    expect(desc.data.results.map((r: any) => r.title)).toEqual(['P5', 'P4', 'P3'])
    const next = await api.client.get(desc.data.next)
    expect(next.data.results.map((r: any) => r.title)).toEqual(['P2', 'P1'])
    expect(next.data.next).toBeNull()
    const ordered = await api.client.get('/api/ordered-cursor/', { ordering: '-title' })
    expect(ordered.data.results.map((r: any) => r.title)).toEqual(['P5', 'P4', 'P3'])
    const bad = await api.client.get('/api/id-cursor/', { cursor: '%%%' })
    expect(bad.status).toBe(404)
    expect(bad.data).toEqual({ detail: 'Invalid cursor' })
  })

  it('paginationClass = null disables pagination', async () => {
    await seed(5)
    const res = await api.client.get('/api/unpaginated/')
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data).toHaveLength(5)
  })
})

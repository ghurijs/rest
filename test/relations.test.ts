import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  DefaultRouter,
  extendSchema,
  generateSchema,
  IntegerField,
  ModelSerializer,
  ModelViewSet,
  PrimaryKeyRelatedField,
  SlugRelatedField,
  StringRelatedField,
} from '../src/index'
import { useApi } from './helpers'
import { Member, Post, Tag } from './models'

class PostSerializer extends ModelSerializer {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'author', 'tags', 'editor', 'authorLabel', 'authorPk'],
  }
  author = new SlugRelatedField({ slugField: 'username', queryset: Member.objects.all() })
  tags = new SlugRelatedField({ slugField: 'name', queryset: Tag.objects.all(), many: true, required: false })
  editor = new PrimaryKeyRelatedField({
    queryset: () => Member.objects.filter({ isStaff: true }),
    allowNull: true,
    required: false,
  })
  authorLabel = new StringRelatedField({ source: 'author' })
  authorPk = new PrimaryKeyRelatedField({ source: 'author', readOnly: true, pkField: new IntegerField() })
}

@extendSchema({ tags: ['everything'] })
class PostViewSet extends ModelViewSet {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
}

const router = new DefaultRouter()
router.register('posts', PostViewSet)
const urls = [path('api/', include(router.urls))]

describe('relational fields and HTML/OPTIONS for detail routes', () => {
  const api = useApi(() => ({ urls }))

  it('reads and writes slug / pk relations', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const boss = await Member.objects.create({ username: 'boss', isStaff: true })
    await Tag.objects.create({ name: 'js' })
    const created = await api.client.post('/api/posts/', {
      title: 'T',
      slug: 't',
      author: 'ann',
      tags: ['js'],
      editor: boss.id,
    })
    expect(created.status).toBe(201)
    expect(created.data).toEqual({
      id: expect.any(Number),
      title: 'T',
      slug: 't',
      author: 'ann',
      tags: ['js'],
      editor: boss.id,
      authorLabel: 'ann',
      authorPk: ann.id,
    })
    const bad = await api.client.post('/api/posts/', {
      title: 'U',
      slug: 'u',
      author: 'nobody',
      tags: ['nope'],
      editor: ann.id,
    })
    expect(bad.data).toEqual({
      author: ['Object with username=nobody does not exist.'],
      tags: ['Object with name=nope does not exist.'],
      editor: [`Invalid pk "${ann.id}" - object does not exist.`],
    })
    const wrongType = await api.client.post('/api/posts/', {
      title: 'U',
      slug: 'u',
      author: 'ann',
      editor: { id: 1 },
    })
    expect(wrongType.data).toEqual({ editor: ['Incorrect type. Expected pk value, received dict.'] })
    const cleared = await api.client.patch(`/api/posts/${created.data.id}/`, { editor: null, tags: [] })
    expect(cleared.data).toMatchObject({ editor: null, tags: [] })
  })

  it('renders detail pages, OPTIONS with PUT, and class-level schema overrides', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const post = await Post.objects.create({ title: 'T', slug: 't', author: ann })
    const html = await api.client.get(`/api/posts/${post.id}/`, undefined, {
      headers: { Accept: 'text/html' },
    })
    const page = await html.text()
    expect(page).toContain('Post Instance')
    expect(page).toContain('data-method="PUT"')
    expect(page).toContain('data-method="DELETE"')
    const opts = await api.client.options(`/api/posts/${post.id}/`)
    expect(Object.keys(opts.data.actions)).toEqual(['PUT'])
    expect(opts.data.actions.PUT.author).toMatchObject({ type: 'field', required: true })
    const doc = generateSchema(urls)
    expect(doc.paths['/api/posts/{id}/'].get.tags).toEqual(['everything'])
    expect(doc.components.schemas.Post.properties.author).toMatchObject({ type: 'string' })
    expect(doc.components.schemas.Post.properties.tags).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    })
  })
})

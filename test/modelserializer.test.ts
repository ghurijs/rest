import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  BooleanField,
  CharField,
  ChoiceField,
  DateTimeField,
  DecimalField,
  DefaultRouter,
  HyperlinkedModelSerializer,
  IntegerField,
  JSONField,
  ManyRelatedField,
  ModelSerializer,
  ModelViewSet,
  PrimaryKeyRelatedField,
  ReadOnlyField,
  SlugField,
  UniqueValidator,
  ValidationError,
} from '../src/index'
import { backends, useApi } from './helpers'
import { Comment, Event, Member, Post, Tag } from './models'

class PostAllSerializer extends ModelSerializer<Post> {
  static Meta = { model: Post, fields: '__all__' }
}

class MemberSerializer extends ModelSerializer<Member> {
  static Meta = { model: Member, fields: ['id', 'username'] }
}

class CommentSerializer extends ModelSerializer<Comment> {
  static Meta = { model: Comment, fields: ['id', 'post', 'rank', 'text'] }
}

class HyperTagSerializer extends HyperlinkedModelSerializer<Tag> {
  static Meta = { model: Tag, fields: ['url', 'name'] }
}
class HyperPostSerializer extends HyperlinkedModelSerializer<Post> {
  static Meta = { model: Post, fields: ['url', 'id', 'title', 'slug', 'author', 'tags'] }
}
class HyperMemberSerializer extends HyperlinkedModelSerializer<Member> {
  static Meta = { model: Member, fields: ['url', 'username'] }
}

const router = new DefaultRouter()
router.register(
  'members',
  class MemberViewSet extends ModelViewSet {
    queryset = Member.objects.all()
    serializerClass = HyperMemberSerializer
  },
)
router.register(
  'tags',
  class TagViewSet extends ModelViewSet {
    queryset = Tag.objects.all()
    serializerClass = HyperTagSerializer
  },
)
router.register(
  'posts',
  class PostViewSet extends ModelViewSet {
    queryset = Post.objects.all()
    serializerClass = HyperPostSerializer
  },
)

describe('ModelSerializer field generation', () => {
  it('maps model fields to serializer fields with DRF kwargs', () => {
    const f = new PostAllSerializer().fields
    expect(Object.keys(f)).toEqual([
      'id',
      'title',
      'slug',
      'body',
      'published',
      'rating',
      'status',
      'views',
      'extra',
      'createdAt',
      'author',
      'editor',
      'tags',
    ])
    expect(f.id).toBeInstanceOf(IntegerField)
    expect(f.id.readOnly).toBe(true)
    expect(f.title).toBeInstanceOf(CharField)
    expect(f.title).toMatchObject({ maxLength: 100, required: true, helpText: 'Headline', label: 'Title' })
    expect(f.slug).toBeInstanceOf(SlugField)
    expect(f.slug.validators.some((v) => v instanceof UniqueValidator)).toBe(true)
    expect(f.body).toMatchObject({ required: false, allowBlank: true })
    expect(f.published).toBeInstanceOf(BooleanField)
    expect(f.published.required).toBe(false)
    expect(f.rating).toBeInstanceOf(DecimalField)
    expect(f.rating).toMatchObject({ allowNull: true, required: false, maxDigits: 4, decimalPlaces: 2 })
    expect(f.status).toBeInstanceOf(ChoiceField)
    expect((f.status as ChoiceField).choices).toEqual([
      ['draft', 'Draft'],
      ['live', 'Live'],
    ])
    expect(f.views).toMatchObject({ minValue: 0, required: false })
    expect(f.extra).toBeInstanceOf(JSONField)
    expect(f.createdAt).toBeInstanceOf(DateTimeField)
    expect(f.createdAt.readOnly).toBe(true)
    expect(f.author).toBeInstanceOf(PrimaryKeyRelatedField)
    expect(f.author.required).toBe(true)
    expect(f.editor).toMatchObject({ allowNull: true, required: false })
    expect(f.tags).toBeInstanceOf(ManyRelatedField)
    expect(f.tags).toMatchObject({ required: false, allowEmpty: true })
  })

  it('supports exclude, properties, reverse relations, extraKwargs and readOnlyFields', () => {
    class S extends ModelSerializer {
      static Meta = { model: Post, exclude: ['body', 'extra', 'tags', 'editor'] }
    }
    expect(Object.keys(new S().fields)).toEqual([
      'id',
      'title',
      'slug',
      'published',
      'rating',
      'status',
      'views',
      'createdAt',
      'author',
    ])
    void Comment._meta // reverse relations exist once the other side is prepared (apps.populate does this)
    class P extends ModelSerializer {
      static Meta = {
        model: Post,
        fields: ['id', 'titleUpper', 'comments', 'title', 'slug'],
        extraKwargs: { title: { writeOnly: true }, slug: { required: false } },
        readOnlyFields: ['slug'],
      }
    }
    const f = new P().fields
    expect(f.titleUpper).toBeInstanceOf(ReadOnlyField)
    expect(f.comments).toBeInstanceOf(ManyRelatedField)
    expect(f.comments.readOnly).toBe(true)
    expect(f.title.writeOnly).toBe(true)
    expect(f.slug.readOnly).toBe(true)
    expect(f.slug.required).toBe(false)
  })

  it('rejects bad Meta', () => {
    class Both extends ModelSerializer {
      static Meta = { model: Post, fields: ['id'], exclude: ['title'] }
    }
    expect(() => new Both().fields).toThrow(/Cannot set both 'fields' and 'exclude'/)
    class Neither extends ModelSerializer {
      static Meta = { model: Post }
    }
    expect(() => new Neither().fields).toThrow(
      /without either the 'fields' attribute or the 'exclude' attribute/,
    )
    class Unknown extends ModelSerializer {
      static Meta = { model: Post, fields: ['nope'] }
    }
    expect(() => new Unknown().fields).toThrow(
      'Field name `nope` is not valid for model `Post` in `Unknown`.',
    )
  })

  it('generates JSON Schema from the model', () => {
    class S extends ModelSerializer {
      static Meta = {
        model: Post,
        fields: ['id', 'title', 'rating', 'status', 'author', 'tags', 'createdAt'],
      }
    }
    const out = S.jsonSchema()
    expect(out.properties.id).toMatchObject({ type: 'integer', readOnly: true })
    expect(out.properties.rating).toMatchObject({ type: ['string', 'null'], format: 'decimal' })
    expect(out.properties.status).toMatchObject({ enum: ['draft', 'live'], type: 'string' })
    expect(out.properties.author).toMatchObject({ type: 'integer' })
    expect(out.properties.tags).toMatchObject({ type: 'array', items: { type: 'integer' } })
    const input = S.jsonSchema({ mode: 'input' })
    expect(input.required).toEqual(['title', 'author'])
    expect(input.properties.id).toBeUndefined()
    expect(input.properties.createdAt).toBeUndefined()
  })
})

describe.each(backends)('ModelSerializer with a database (%s)', (backend) => {
  const api = useApi(() => ({ backend, urls: [path('api/', include(router.urls))] }))

  it('creates and updates with FK and M2M values', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const js = await Tag.objects.create({ name: 'js' })
    const ts = await Tag.objects.create({ name: 'ts' })
    const s = new PostAllSerializer({
      data: { title: 'T', slug: 't', author: ann.id, tags: [js.id, ts.id], rating: 1.5 },
    })
    expect(await s.isValid()).toBe(true)
    const post = await s.save()
    expect(post.authorId).toBe(ann.id)
    expect((await post.tags.all()).map((t) => t.name)).toEqual(['js', 'ts'])
    expect(await s.getData()).toMatchObject({
      title: 'T',
      author: ann.id,
      tags: [js.id, ts.id],
      rating: '1.50',
      editor: null,
    })

    const u = new PostAllSerializer({
      instance: post,
      data: { tags: [ts.id], editor: ann.id },
      partial: true,
    })
    expect(await u.isValid()).toBe(true)
    await u.save()
    const fresh = await Post.objects.get({ pk: post.id })
    expect(fresh.editorId).toBe(ann.id)
    expect((await fresh.tags.all()).map((t) => t.name)).toEqual(['ts'])
  })

  it('validates unique fields excluding the instance being updated', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const dup = new MemberSerializer({ data: { username: 'ann' } })
    expect(await dup.isValid()).toBe(false)
    expect(dup.errors).toEqual({ username: ['Member with this Username already exists.'] })
    const same = new MemberSerializer({ instance: ann, data: { username: 'ann' } })
    expect(await same.isValid()).toBe(true)
  })

  it('validates unique together', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const post = await Post.objects.create({ title: 'T', slug: 't', author: ann })
    await Comment.objects.create({ post, rank: 1, text: 'first' })
    const dup = new CommentSerializer({ data: { post: post.id, rank: 1, text: 'again' } })
    expect(await dup.isValid()).toBe(false)
    expect(dup.errors).toEqual({ nonFieldErrors: ['The fields post, rank must make a unique set.'] })
    const ok = new CommentSerializer({ data: { post: post.id, rank: 2, text: 'second' } })
    expect(await ok.isValid()).toBe(true)
    const missing = new CommentSerializer({ data: { post: post.id, text: 'x' } })
    expect(await missing.isValid()).toBe(false)
    expect(missing.errors).toEqual({ rank: ['This field is required.'] })
  })

  it('nests related objects with depth', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const post = await Post.objects.create({ title: 'T', slug: 't', author: ann })
    await post.tags.add(await Tag.objects.create({ name: 'js' }))
    class Deep extends ModelSerializer {
      static Meta = { model: Post, fields: ['id', 'author', 'tags'], depth: 1 }
    }
    expect(await new Deep({ instance: post }).getData()).toEqual({
      id: post.id,
      author: { id: ann.id, username: 'ann', isStaff: false },
      tags: [{ id: expect.any(Number), name: 'js' }],
    })
  })

  it('refuses writable nested data unless create() is overridden', async () => {
    class Nested extends ModelSerializer {
      static Meta = { model: Post, fields: ['title', 'slug', 'author'] }
      author = new MemberSerializer()
    }
    const s = new Nested({ data: { title: 'T', slug: 't', author: { username: 'zed' } } })
    expect(await s.isValid()).toBe(true)
    await expect(s.save()).rejects.toThrow(/does not support writable nested fields/)

    class Writable extends Nested {
      override async create(data: any) {
        const author = await Member.objects.create(data.author)
        return Post.objects.create({ ...data, author })
      }
    }
    const w = new Writable({ data: { title: 'T', slug: 't', author: { username: 'zed' } } })
    expect(await w.isValid()).toBe(true)
    const post = await w.save()
    expect(await w.getData()).toEqual({
      title: 'T',
      slug: 't',
      author: { id: post.authorId, username: 'zed' },
    })
  })

  it('runs model fullClean() when Meta.fullClean is set', async () => {
    class EventSerializer extends ModelSerializer {
      static Meta = { model: Event, fields: ['id', 'name', 'capacity'], fullClean: true }
    }
    const s = new EventSerializer({ data: { name: 'Big', capacity: 500 } })
    expect(await s.isValid()).toBe(true)
    await expect(s.save()).rejects.toMatchObject({ detail: { capacity: ['Too many seats.'] } })
    const s2 = new EventSerializer({ data: { name: 'nope' } })
    expect(await s2.isValid()).toBe(true)
    await expect(s2.save()).rejects.toBeInstanceOf(ValidationError)
    expect(await Event.objects.count()).toBe(0)
    const ok = new EventSerializer({ data: { name: 'Fine', capacity: 50 } })
    expect(await ok.isValid()).toBe(true)
    await ok.save()
    expect(await Event.objects.count()).toBe(1)
  })

  it('HyperlinkedModelSerializer renders and accepts hyperlinks', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const js = await Tag.objects.create({ name: 'js' })
    const post = await Post.objects.create({ title: 'T', slug: 't', author: ann })
    await post.tags.add(js)
    const res = await api.client.get(`/api/posts/${post.id}/`)
    expect(res.data).toEqual({
      url: `http://testserver/api/posts/${post.id}/`,
      id: post.id,
      title: 'T',
      slug: 't',
      author: `http://testserver/api/members/${ann.id}/`,
      tags: [`http://testserver/api/tags/${js.id}/`],
    })
    const created = await api.client.post('/api/posts/', {
      title: 'U',
      slug: 'u',
      author: `http://testserver/api/members/${ann.id}/`,
      tags: [],
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('location')).toBe(created.data.url)
    const bad = await api.client.post('/api/posts/', {
      title: 'V',
      slug: 'v',
      author: `http://testserver/api/tags/${js.id}/`,
    })
    expect(bad.data).toEqual({ author: ['Invalid hyperlink - Incorrect URL match.'] })
    const missing = await api.client.post('/api/posts/', {
      title: 'V',
      slug: 'v',
      author: 'http://testserver/nowhere/',
    })
    expect(missing.data).toEqual({ author: ['Invalid hyperlink - No URL match.'] })
  })
})

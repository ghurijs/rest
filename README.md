# @ghuri/rest

Django REST Framework for [Ghuri](https://github.com/ghurijs/ghuri) — serializers, API views, generic views,
viewsets, routers, permissions, pagination, filtering, throttling and OpenAPI 3.1, with DRF's names in camelCase.
Runs on Cloudflare Workers (D1) and on Node with PostgreSQL / SQLite.

> Status: alpha (`0.1.0-alpha.0`). APIs may change.

```bash
npm install @ghuri/rest@next
```

If you know DRF you already know this package. The differences that matter are listed in
[Coming from DRF](#coming-from-drf).

## Contents

1. [Serializers](#1-serializers)
2. [API views](#2-api-views)
3. [Generic views and mixins](#3-generic-views-and-mixins)
4. [ViewSets and routers](#4-viewsets-and-routers)
5. [Authentication and permissions](#5-authentication-and-permissions)
6. [Pagination, filtering, throttling](#6-pagination-filtering-throttling)
7. [OpenAPI](#7-openapi)
8. [Testing](#8-testing)
9. [Settings](#9-settings)
10. [Introspection (for agents and tools)](#10-introspection-for-agents-and-tools)
11. [Coming from DRF](#coming-from-drf)

The examples use this model:

```ts
// src/blog/models.ts
import { CASCADE, CharField, DateTimeField, ForeignKey, Manager, ManyToManyField, Model, SlugField, TextField } from '@ghuri/orm'
import { User } from '@ghuri/auth'

export class Tag extends Model({ name: new CharField({ maxLength: 50, unique: true }) }) {}

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  slug: new SlugField({ unique: true }),
  body: new TextField({ blank: true }),
  author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'posts' }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Post>
}
```

## 1. Serializers

Declare fields as class properties. Validation and output are **async** (relations are loaded lazily):
`await serializer.isValid()`, `await serializer.getData()`.

```ts
import { CharField, DateTimeField, EmailField, Serializer, ValidationError } from '@ghuri/rest'

class CommentSerializer extends Serializer {
  email = new EmailField()
  content = new CharField({ maxLength: 200 })
  created = new DateTimeField({ readOnly: true })

  validateContent(value: string) {            // DRF's validate_content
    if (value.includes('spam')) throw new ValidationError('No spam.')
    return value
  }
  validate(attrs: any) {                       // object-level, may be async
    return attrs
  }
  async create(data: any) { return Comment.objects.create(data) }
  async update(instance: Comment, data: any) { Object.assign(instance, data); await instance.save(); return instance }
}

const s = new CommentSerializer({ data: { email: 'leila@example.com', content: 'foo bar' } })
await s.isValid()            // true
s.validatedData              // { email, content }
await s.save()               // create(); save({ extra: 1 }) merges extra values
await s.getData()            // output; afterwards `s.data` returns the cached value

const bad = new CommentSerializer({ data: { email: 'nope' } })
await bad.isValid()          // false
bad.errors                   // { email: ['Enter a valid email address.'], content: ['This field is required.'] }
await bad.isValid({ raiseException: true })   // throws ValidationError → 400 in views
```

- Constructor options: `{ instance, data, partial, context, many, ...fieldOptions }`.
- `many: true` returns a `ListSerializer` (`PostSerializer.many({...})` is the typed alternative).
- Field options: `readOnly`, `writeOnly`, `required`, `default` (value, function or `new CurrentUserDefault()`),
  `allowNull`, `allowBlank`, `source` (`'author.username'`, `'*'`), `label`, `helpText`, `validators`, `errorMessages`.
- Validators and `validateX` / `validate` hooks may throw the REST `ValidationError` or core's `ValidationError`
  (the ORM's validators work unchanged). Errors use DRF's shape; object-level errors go under `nonFieldErrors`.
- Fields: `BooleanField`, `CharField`, `EmailField`, `RegexField`, `SlugField`, `URLField`, `UUIDField`,
  `IPAddressField`, `IntegerField`, `FloatField`, `DecimalField` (strings, like the ORM), `DateTimeField`, `DateField`,
  `TimeField`, `DurationField` (milliseconds, DRF string format), `ChoiceField`, `MultipleChoiceField`, `FileField`,
  `ImageField`, `ListField`, `DictField`, `JSONField`, `ReadOnlyField`, `HiddenField`, `SerializerMethodField`.
- Relations: `PrimaryKeyRelatedField`, `SlugRelatedField`, `StringRelatedField`, `HyperlinkedRelatedField`,
  `HyperlinkedIdentityField`, `ManyRelatedField` (via `many: true`).

### ModelSerializer

```ts
import { CharField, ModelSerializer, SerializerMethodField } from '@ghuri/rest'

class PostSerializer extends ModelSerializer<Post> {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'body', 'author', 'tags', 'createdAt'],   // or '__all__' / exclude: [...]
    readOnlyFields: ['author'],
    extraKwargs: { body: { required: true } },
  }
  authorName = new CharField({ source: 'author.username', readOnly: true })   // awaits `post.author`
  commentCount = new SerializerMethodField()

  async getCommentCount(post: Post) { return post.comments.count() }
}
```

- Fields are generated from `Post._meta`: `CharField` (maxLength, allowBlank), `ChoiceField` for `choices`,
  `IntegerField` (min/max from validators), `DecimalField`, `DateTimeField`… `autoNow*` / non-editable fields are
  read-only; `null` → `allowNull`; `blank` / default / null → not required.
- Foreign keys and many-to-many fields become `PrimaryKeyRelatedField`s (`SlugRelatedField` with `toField`);
  `depth: 1` nests related objects read-only. Reverse relations (`comments`) may be listed and are read-only.
- `unique` fields get a `UniqueValidator`, `Meta.uniqueTogether` a `UniqueTogetherValidator`.
- `create()` / `update()` set many-to-many values after saving. Writable nested serializers need your own
  `create()` / `update()` (like DRF, a clear error tells you so).
- `Meta.fullClean: true` also runs the model's `fullClean()` (field validators, `clean()`, uniqueness) before saving;
  its errors become a 400 with DRF's shape.
- `HyperlinkedModelSerializer` uses hyperlinks and a `url` field (`<model>-detail` URL names, as routers create).

## 2. API views

```ts
import { APIResponse, APIView, apiView, IsAdminUser, status, type APIRequest } from '@ghuri/rest'

class ListUsers extends APIView {
  permissionClasses = [IsAdminUser]
  async get(request: APIRequest) {
    return new APIResponse(await User.objects.valuesList('username', { flat: true }))
  }
}

export const hello = apiView(['GET', 'POST'])(async (request) => {
  if (request.method === 'POST') return new APIResponse({ message: 'Got some data!', data: request.data }, status.HTTP_201_CREATED)
  return { message: 'Hello, world!' }        // plain data is wrapped in an APIResponse
})

export const urlpatterns = [path('users/', ListUsers.asView()), path('hello/', hello)]
```

- Handlers receive `(request, kwargs)`; `this.request`, `this.kwargs`, `this.format`, `this.c` (Hono context) are set.
- The request: `request.data` (parsed body: JSON, urlencoded, multipart with `File`s), `request.files`,
  `request.query` / `request.queryParams`, `request.user`, `request.auth`, `request.method`, `request.c`.
- **`request.data` is parsed before your handler runs**, so it is a plain synchronous property. Parse errors
  (`ParseError` 400, `UnsupportedMediaType` 415) are raised when you first read it, like DRF.
- Return an `APIResponse` (rendered by content negotiation: JSON, or the browsable API for browsers), any fetch
  `Response` (sent as-is), or plain data.
- Order of operations: parse → content negotiation → authentication → permissions → throttles → handler. Override
  `initial()`, `handleException()`, `finalizeResponse()`, `getPermissions()`, `checkObjectPermissions()` as in DRF.
- Errors: `APIException` and subclasses (`ValidationError`, `ParseError`, `AuthenticationFailed`,
  `NotAuthenticated`, `PermissionDenied`, `NotFound`, `MethodNotAllowed`, `NotAcceptable`, `UnsupportedMediaType`,
  `Throttled`) render as `{ "detail": ... }` or field errors. Core's `Http404`, `PermissionDenied`,
  `ValidationError` and ORM `DoesNotExist` are mapped too. Customize with `REST_FRAMEWORK.EXCEPTION_HANDLER`.
- API views are CSRF-exempt; session-style authentication enforces CSRF itself (as in DRF).
- `OPTIONS` returns metadata (`SimpleMetadata`) including the fields of POST / PUT.

## 3. Generic views and mixins

```ts
import { ListCreateAPIView, RetrieveUpdateDestroyAPIView } from '@ghuri/rest'

class PostList extends ListCreateAPIView {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  async performCreate(serializer: any) {
    await serializer.save({ author: this.request.user })
  }
}

class PostDetail extends RetrieveUpdateDestroyAPIView {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  lookupField = 'slug'
}
```

`GenericAPIView` provides `getQueryset()`, `getObject()` (404 + object permissions), `getSerializer()`,
`getSerializerClass()`, `getSerializerContext()`, `filterQueryset()`, `paginateQueryset()`,
`getPaginatedResponse()`. Concrete views: `CreateAPIView`, `ListAPIView`, `RetrieveAPIView`, `DestroyAPIView`,
`UpdateAPIView`, `ListCreateAPIView`, `RetrieveUpdateAPIView`, `RetrieveDestroyAPIView`, `RetrieveUpdateDestroyAPIView`.

**Mixins are class factories** (TypeScript has no multiple inheritance). DRF's
`class V(mixins.ListModelMixin, mixins.CreateModelMixin, GenericAPIView)` becomes:

```ts
import { CreateModelMixin, GenericAPIView, GenericViewSet, ListModelMixin } from '@ghuri/rest'

class PostList extends ListModelMixin(CreateModelMixin(GenericAPIView)) {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  get(request: APIRequest) { return this.list(request) }
  post(request: APIRequest) { return this.create(request) }
}

class CreateListViewSet extends CreateModelMixin(ListModelMixin(GenericViewSet)) {}
```

The mixins: `CreateModelMixin` (`create`, `performCreate`), `ListModelMixin` (`list`), `RetrieveModelMixin`
(`retrieve`), `UpdateModelMixin` (`update`, `partialUpdate`, `performUpdate`), `DestroyModelMixin` (`destroy`,
`performDestroy`).

## 4. ViewSets and routers

```ts
import { action, DefaultRouter, IsAuthenticatedOrReadOnly, ModelViewSet, type APIRequest } from '@ghuri/rest'

class PostViewSet extends ModelViewSet<Post> {
  queryset = Post.objects.all()
  serializerClass = PostSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly]

  async performCreate(serializer: any) {
    await serializer.save({ author: this.request.user })
  }

  @action({ detail: true, methods: ['post'], permissionClasses: [IsAdminUser] })
  async publish(request: APIRequest) {
    const post = await this.getObject()
    post.published = true
    await post.save()
    return { status: 'published' }
  }

  @action({ detail: false })
  async recent(request: APIRequest) {        // this.action === 'recent'
    const serializer = this.getSerializer({ instance: await this.getQueryset().slice(0, 5), many: true })
    return serializer.getData()
  }
}

const router = new DefaultRouter()           // or new SimpleRouter({ trailingSlash: false })
router.register('posts', PostViewSet)        // basename 'post' (from the queryset's model) or { basename }

export const urlpatterns = [path('api/', include(router.urls))]
```

| URL | Name | Methods → actions |
|---|---|---|
| `api/` | `api-root` | GET (DefaultRouter only) |
| `api/posts/` | `post-list` | GET list, POST create |
| `api/posts/recent/` | `post-recent` | GET recent |
| `api/posts/<pk>/` | `post-detail` | GET retrieve, PUT update, PATCH partialUpdate, DELETE destroy |
| `api/posts/<pk>/publish/` | `post-publish` | POST publish |

`DefaultRouter` also routes `posts.json` / `posts/1.json` format suffixes (`includeFormatSuffixes: false` to turn
off). Inside handlers: `this.action`, `this.detail`, `this.basename`, `this.reverseAction('detail', { pk })`.

**`@action` works three ways.** It is a TC39 (stage 3) decorator — what TypeScript 5 and esbuild/tsup/wrangler
compile by default — and also works as a legacy `experimentalDecorators` decorator. Without decorators:

```ts
class PostViewSet extends ModelViewSet {
  static actions = { publish: action({ detail: true, methods: ['post'] }) }
  async publish(request: APIRequest) { ... }
}
```

Options: `detail` (required), `methods` (default `['get']`), `urlPath` / `urlName` (default: the method name in
kebab-case, `setPassword` → `set-password/`, `post-set-password`), plus any view attribute to override for the
route (`permissionClasses`, `serializerClass`, `throttleScope`, `name`, …).

> Vitest note: Vite 8 transforms TypeScript with oxc, which does not lower TC39 decorators yet. Either pre-transform
> with esbuild in `vitest.config.ts` (see this package's config) or use `static actions`.

Other viewsets: `ViewSet` (write `list`, `retrieve`… yourself), `GenericViewSet`, `ReadOnlyModelViewSet`.
Lookups: `lookupField`, `lookupUrlKwarg`, `lookupValueRegex` (default `[^/.]+`) or `lookupValueConverter`
(`'int'`, `'uuid'`, `'slug'`).

## 5. Authentication and permissions

Authentication classes implement this contract (DRF's `BaseAuthentication`):

```ts
interface BaseAuthentication {
  authenticate(c: Context): Promise<[RequestUser, unknown] | null>   // null: not my scheme; throw AuthenticationFailed: bad credentials
  authenticateHeader?(c: Context): string | undefined                 // WWW-Authenticate → 401 instead of 403
}
```

`SessionAuthentication`, `TokenAuthentication`, `JWTAuthentication` and `BasicAuthentication` ship with
`@ghuri/auth/rest`. This package's default, `MiddlewareAuthentication`, uses the user set by `AuthenticationMiddleware`
(core's `setUser`) and enforces CSRF for unsafe methods.

```ts
import { TokenAuthentication } from '@ghuri/auth/rest'

class PostViewSet extends ModelViewSet {
  authenticationClasses = [TokenAuthentication]
  permissionClasses = [IsAuthenticated.and(IsOwner).or(IsAdminUser)]      // DRF's &, |, ~ : .and() .or() .not()
}

class IsOwner extends BasePermission {
  message = 'You must be the author.'
  async hasObjectPermission(request: APIRequest, view: any, obj: Post) {
    return SAFE_METHODS.includes(request.method) || obj.authorId === request.user.pk
  }
}
```

Built-ins: `AllowAny`, `IsAuthenticated`, `IsAdminUser` (`user.isStaff`), `IsAuthenticatedOrReadOnly`,
`ModelPermissions` (`user.hasPerm('blog.add_post')` for POST, `change_` for PUT/PATCH, `delete_` for DELETE),
`ModelPermissionsOrAnonReadOnly`, `ObjectPermissions` (`user.hasPerm(perm, obj)`). `hasPermission` and
`hasObjectPermission` may be async. Unauthenticated requests get 401 when the first authentication class has an
`authenticateHeader`, else 403.

## 6. Pagination, filtering, throttling

```ts
// settings.ts
REST_FRAMEWORK: {
  DEFAULT_PAGINATION_CLASS: PageNumberPagination,
  PAGE_SIZE: 20,
  DEFAULT_FILTER_BACKENDS: [SearchFilter, OrderingFilter, FieldFilter],
  DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle, UserRateThrottle],
  DEFAULT_THROTTLE_RATES: { anon: '100/hour', user: '1000/day', uploads: '10/minute' },
}
```

- `PageNumberPagination` (`?page=2`, `pageSizeQueryParam`, `maxPageSize`, `'last'`) and `LimitOffsetPagination`
  (`?limit=&offset=`) return `{ count, next, previous, results }`; `CursorPagination` (opaque cursor over
  `ordering`, default `'-createdAt'`) returns `{ next, previous, results }`. Set `paginationClass = null` to disable.
- `SearchFilter` — `?search=foo bar`, `searchFields = ['title', '^slug', '=email', '@body', 'author__username']`
  (`^` starts-with, `=` exact, `@` full-text → `icontains`, `$` regex).
- `OrderingFilter` — `?ordering=-createdAt,title`, `orderingFields` (or `'__all__'`), default `ordering`.
- `FieldFilter` (a small django-filter) — `filtersetFields = ['published']` or
  `{ createdAt: ['gte', 'lte'], views: ['exact', 'in'], title: ['icontains'] }` → `?createdAt__gte=2024-01-01`.
  Values are converted by the model field; invalid values give 400.
- `AnonRateThrottle`, `UserRateThrottle`, `ScopedRateThrottle` (`throttleScope = 'uploads'`) keep request history in
  the core cache (KV on Workers). Rates: `'100/hour'`, `'5/s'`, `'10/5m'`. Clients are identified by
  `CF-Connecting-IP` / `X-Forwarded-For` (`NUM_PROXIES`).

## 7. OpenAPI

```ts
import { generateSchema, ScalarView, SchemaView, SwaggerUIView } from '@ghuri/rest'

export const urlpatterns = [
  path('api/', include(router.urls)),
  path('api/schema/', SchemaView.asView({ title: 'Blog API', version: '1.0.0' }), { name: 'schema' }),
  path('api/docs/', SwaggerUIView.asView({ urlName: 'schema' })),
  path('api/reference/', ScalarView.asView({ urlName: 'schema' })),
]

const doc = generateSchema(router, { title: 'Blog API', prefix: 'api/' })   // or generateSchema(urlpatterns, {...})
```

The OpenAPI 3.1 document has an operation per route and method (`listPosts`, `createPost`, `retrievePost`,
`partialUpdatePost`, `publishPost`…), path / pagination / filter parameters, request bodies
(`PostRequest`, `PatchedPostRequest`) and responses (`Post`, paginated envelopes, 400 / 401 / 403 / 404 / 429)
from serializers, and security schemes from authentication classes with a static `securityScheme`.
Customize per view with `schema = new AutoSchema({ tags, operationIdBase, componentName })`, exclude with
`schema = null`, or override operations with `extendSchema` (decorator or wrapper):

```ts
@extendSchema({ summary: 'Publish a post', request: null, responses: PublishResultSerializer, tags: ['publishing'] })
@action({ detail: true, methods: ['post'] })
async publish(request: APIRequest) { ... }
```

## 8. Testing

```ts
import { APIClient } from '@ghuri/rest/testing'

const client = new APIClient(app, { env, defaultFormat: 'json' })
client.forceAuthenticate(user)                       // bypass authentication classes
client.credentials({ Authorization: 'Token abc' })   // headers for every request
const res = await client.post('/api/posts/', { title: 'Hi', slug: 'hi' }, { format: 'json' })
expect(res.status).toBe(201)
expect(res.data.title).toBe('Hi')                    // parsed JSON, like DRF's response.data
await client.get('/api/posts/', { search: 'hi' })    // second argument: query parameters
```

Use the same `env` object for `app.setup(env)`, `setupTestDatabase()` and the client so requests see the test
database. Formats: `'json'`, `'multipart'` (default, `TEST_REQUEST_DEFAULT_FORMAT`), `'form'`.

## 9. Settings

`REST_FRAMEWORK` in your settings, read at request time through `apiSettings` (DRF's `api_settings`). Classes are
referenced directly (no dotted strings). Defaults:

| Key | Default |
|---|---|
| `DEFAULT_RENDERER_CLASSES` | `[JSONRenderer, BrowsableAPIRenderer]` |
| `DEFAULT_PARSER_CLASSES` | `[JSONParser, FormParser, MultiPartParser]` |
| `DEFAULT_AUTHENTICATION_CLASSES` | `[MiddlewareAuthentication]` |
| `DEFAULT_PERMISSION_CLASSES` | `[AllowAny]` |
| `DEFAULT_THROTTLE_CLASSES` | `[]` |
| `DEFAULT_CONTENT_NEGOTIATION_CLASS` | `DefaultContentNegotiation` |
| `DEFAULT_METADATA_CLASS` | `SimpleMetadata` |
| `DEFAULT_PAGINATION_CLASS` / `PAGE_SIZE` | `null` / `null` |
| `DEFAULT_FILTER_BACKENDS` | `[]` |
| `DEFAULT_SCHEMA_CLASS` | `AutoSchema` |
| `DEFAULT_THROTTLE_RATES` / `THROTTLE_CACHE` / `NUM_PROXIES` | `{ user: null, anon: null }` / `'default'` / `null` |
| `UNAUTHENTICATED_USER` / `UNAUTHENTICATED_TOKEN` | `() => new AnonymousUser()` / `null` |
| `SEARCH_PARAM` / `ORDERING_PARAM` | `'search'` / `'ordering'` |
| `EXCEPTION_HANDLER` / `NON_FIELD_ERRORS_KEY` | `exceptionHandler` / `'nonFieldErrors'` |
| `URL_FORMAT_OVERRIDE` / `FORMAT_SUFFIX_KWARG` / `URL_FIELD_NAME` | `'format'` / `'format'` / `'url'` |
| `DATETIME_FORMAT` / `DATE_FORMAT` / `TIME_FORMAT` | `'iso-8601'` |
| `COERCE_DECIMAL_TO_STRING` / `UPLOADED_FILES_USE_URL` | `true` / `true` |
| `TEST_REQUEST_DEFAULT_FORMAT` | `'multipart'` |

`status` has DRF's constants and helpers: `status.HTTP_201_CREATED`, `status.isSuccess(code)`.

## 10. Introspection (for agents and tools)

```ts
router.registry                      // RouterRegistration[]: { prefix, viewset, basename, … }
const posts = router.registry[0]
posts.model                          // Post
posts.actions                        // ['list', 'create', 'retrieve', 'update', 'partialUpdate', 'destroy', 'publish']
posts.endpoints                      // [{ action: 'publish', method: 'POST', detail: true, name: 'post-publish', pattern, extra: true }, …]
posts.routes                         // [{ name: 'post-detail', pattern: 'posts/<restlookup:pk>/', detail: true, methods: { GET: 'retrieve', … } }, …]
posts.getSerializerClass('create')   // honors getSerializerClass() overrides keyed on this.action
posts.jsonSchema('create', { mode: 'input' })   // JSON Schema for a tool's input
await posts.invoke('create', { user, data: { title: 'Hi', slug: 'hi' } })   // { status, data } — full pipeline, no HTTP
router.describe()                    // plain JSON of the above

PostSerializer.jsonSchema()                         // output schema (JSON Schema 2020-12)
new PostSerializer().jsonSchema({ mode: 'input', partial: true })
```

## Coming from DRF

- Async: `await serializer.isValid()`, `await serializer.getData()` (then `serializer.data`), `await serializer.save()`;
  `getAttribute`/`toRepresentation`/`toInternalValue`/validators/permissions may be async.
- camelCase everywhere: `read_only` → `readOnly`, `validate_title` → `validateTitle`, `partial_update` →
  `partialUpdate`, `non_field_errors` → `nonFieldErrors`, metadata keys (`readOnly`, `helpText`, `displayName`).
- Handlers get `(request, kwargs)`; return data, an `APIResponse` (DRF's `Response`; the name avoids shadowing fetch's
  `Response`) or a raw `Response`. `Request` is exported too (alias of `APIRequest`).
- Mixins are class factories; `@action` is a TC39 decorator (or `static actions`); default `urlPath` is kebab-case.
- Declared serializer fields missing from `Meta.fields` are appended instead of raising.
- Reverse relations in ModelSerializer `fields` are read-only.
- `FieldFilter` replaces django-filter's `DjangoFilterBackend` (also exported under that name) for simple lookups.
- `CursorPagination.ordering` defaults to `'-createdAt'`.
- `DurationField` values are milliseconds (the ORM's representation); output uses DRF's `[DD ]HH:MM:SS[.uuuuuu]`.
- Overriding a policy list in a subclass of a class that set it may need a wider type:
  `authenticationClasses: AuthenticationClass[] = [TokenAuthentication]` (TypeScript infers the narrowest array type).
- No API versioning classes or `TemplateHTMLRenderer` yet.

## License

MIT

# Changelog

## Unreleased

- **Behaviour change — throttle client IPs are safe by default.** `BaseThrottle.getIdent()` no longer reads
  `X-Forwarded-For` (or `X-Real-IP`) unless `REST_FRAMEWORK.NUM_PROXIES` is set. Before, with `NUM_PROXIES`
  unset, a client could send a different `X-Forwarded-For` on every request and get a fresh rate-limit bucket
  each time. The client address now comes from `@ghuri/core`'s `getRemoteAddr(c)`: `CF-Connecting-IP` on
  Cloudflare (Workers or `wrangler dev`), else the Node socket address (recorded by `serve()` from
  `@ghuri/core/node`, or `c.env.incoming` with plain `@hono/node-server`), else `''`. `CF-Connecting-IP` is ignored
  off Cloudflare, where a client could forge it. This differs from DRF, which trusts the whole `X-Forwarded-For`
  value when `NUM_PROXIES` is `None`. With `NUM_PROXIES` set the behaviour is DRF's (`0` ignores the header; `n`
  picks the address `n` hops from the end).
  **Upgrade:** apps behind nginx, a load balancer or Cloudflare in front of a Node server must set
  `NUM_PROXIES` to the number of proxies, or all clients share the proxy's bucket.
- `BaseThrottle.getRemoteAddr(request)` (Django's `REMOTE_ADDR`): the peer address used by `getIdent()`;
  override it to read the address from somewhere else.
- `static xframeOptionsExempt = true` on an `APIView` or `ViewSet` exempts its views from core's
  `XFrameOptionsMiddleware`, like core class views.
- Requires the `@ghuri/core` release that adds `getRemoteAddr` and `XFRAME_OPTIONS_EXEMPT_MARKER`; raise the
  `@ghuri/core` peer range to it when releasing.

## 0.1.0-alpha.1

- `generateschema` command (DRF's): writes the OpenAPI 3.1 schema as YAML (default) or JSON (`--format openapi-json`, or a `--file` ending in `.json`), with `--title`, `--description`, `--api-version` and `--url`. It uses the `SchemaView` routed in `ROOT_URLCONF`, so the file matches what `/api/schema/` serves. Add the new `RestFrameworkConfig` to `INSTALLED_APPS` to get it.

- `@action` / `extendSchema` also work as legacy decorators compiled by Babel with decorator metadata (jiti — the `ghuri` CLI's loader).
- Composed permissions (`A.and(B)`, `.or()`, `.not()`) are typed `ComposedPermission` and chain further: `IsAuthenticated.and(IsStaff).or(IsAdminUser)`.

## 0.1.0-alpha.0

First alpha: a Django REST Framework clone for Ghuri.

- **Serializers**: `Serializer`, `ModelSerializer` (fields from `_meta`, `fields` / `'__all__'` / `exclude`,
  `readOnlyFields`, `extraKwargs`, `depth`, unique / unique-together validators, many-to-many writes, optional
  `Meta.fullClean`), `HyperlinkedModelSerializer`, `ListSerializer` (`many: true`), nested serializers, async
  `isValid()` / `getData()` / `save()`, `validateX()` / `validate()` hooks, DRF error shapes and codes,
  `jsonSchema({ mode, partial })`.
- **Fields**: all DRF scalar, choice, file, composite and relational fields (`PrimaryKeyRelatedField`,
  `SlugRelatedField`, `StringRelatedField`, `HyperlinkedRelatedField`, `HyperlinkedIdentityField`,
  `ManyRelatedField`), `SerializerMethodField`, `HiddenField`, `CurrentUserDefault`, `CreateOnlyDefault`;
  dotted `source` paths await related objects.
- **Requests & responses**: `APIRequest` (pre-parsed `data`, `files`, `query`, `user`, `auth`), JSON / form /
  multipart / raw upload parsers, JSON and browsable-API renderers, content negotiation with `?format=` and `.json`
  suffixes, `APIResponse`, `status`.
- **Views**: `APIView`, `apiView()`, `GenericAPIView`, class-factory mixins, all concrete generic views, `ViewSet`,
  `GenericViewSet`, `ReadOnlyModelViewSet`, `ModelViewSet`, `@action` (TC39 / legacy decorator or `static actions`),
  OPTIONS metadata.
- **Routers**: `SimpleRouter`, `DefaultRouter` (API root, format suffixes, trailing-slash option), introspectable
  `router.registry` (`actions`, `endpoints`, `routes`, `jsonSchema()`, `invoke()`).
- **Auth & permissions**: `BaseAuthentication` contract, `MiddlewareAuthentication` (CSRF-enforcing), `AllowAny`,
  `IsAuthenticated`, `IsAdminUser`, `IsAuthenticatedOrReadOnly`, `ModelPermissions`,
  `ModelPermissionsOrAnonReadOnly`, `ObjectPermissions`, `.and()` / `.or()` / `.not()` composition.
- **Pagination / filtering / throttling**: page-number, limit-offset and cursor pagination; `SearchFilter`,
  `OrderingFilter`, `FieldFilter`; anon / user / scoped rate throttles on the core cache.
- **Exceptions**: DRF exception classes, `exceptionHandler`, mapping of core / ORM errors.
- **OpenAPI 3.1**: `generateSchema()`, `AutoSchema`, `extendSchema()`, `SchemaView`, `SwaggerUIView`, `ScalarView`.
- **Testing**: `@ghuri/rest/testing` `APIClient` with `forceAuthenticate()`, `credentials()` and `response.data`.
- `REST_FRAMEWORK` settings with DRF keys and `apiSettings`.

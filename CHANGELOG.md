# Changelog

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

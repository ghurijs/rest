import { Http404 } from '@ghuri/core'
import { MethodNotAllowed } from './exceptions'
import type { APIRequest } from './request'
import type { MaybePromise } from './utils'

export const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS']

/**
 * Base permission (DRF's `BasePermission`). Override `hasPermission` (view-level) and/or `hasObjectPermission`
 * (checked by `getObject()` / `checkObjectPermissions()`). Both may be async. Set `message` / `code` to
 * customize the 403 detail.
 *
 * Compose classes with `IsAuthenticated.or(IsAdminUser)`, `IsAuthenticated.and(IsOwner)`, `IsAdminUser.not()`
 * (DRF's `|`, `&`, `~`).
 */
export class BasePermission {
  message?: string | Record<string, unknown>
  code?: string

  hasPermission(_request: APIRequest, _view: any): MaybePromise<boolean> {
    return true
  }

  hasObjectPermission(_request: APIRequest, _view: any, _obj: any): MaybePromise<boolean> {
    return true
  }

  /** `A.or(B)`: allowed when either allows (object level: `(A.has && A.hasObj) || (B.has && B.hasObj)`). */
  static or(this: PermissionClass, ...others: PermissionClass[]): ComposedPermission {
    return composeOr([this, ...others])
  }

  /** `A.and(B)`: allowed when both allow. */
  static and(this: PermissionClass, ...others: PermissionClass[]): ComposedPermission {
    return composeAnd([this, ...others])
  }

  /** `A.not()`: allowed when A denies. */
  static not(this: PermissionClass): ComposedPermission {
    return composeNot(this)
  }
}

export type PermissionClass = new () => BasePermission

/**
 * A class returned by `.and()` / `.or()` / `.not()`: a permission class that composes further
 * (`IsAuthenticated.and(IsOwner).or(IsAdminUser)`).
 */
export type ComposedPermission = typeof BasePermission

/** Something with `hasPermission` / `hasObjectPermission` (structural, for permissions not extending BasePermission). */
export interface PermissionLike {
  hasPermission?(request: APIRequest, view: any): MaybePromise<boolean>
  hasObjectPermission?(request: APIRequest, view: any, obj: any): MaybePromise<boolean>
  message?: string | Record<string, unknown>
  code?: string
}

function named<T extends PermissionClass>(cls: T, name: string): T {
  Object.defineProperty(cls, 'name', { value: name })
  return cls
}

function composeOr(classes: PermissionClass[]): ComposedPermission {
  return named(
    class OR extends BasePermission {
      readonly ops = classes.map((C) => new C())
      override async hasPermission(request: APIRequest, view: any): Promise<boolean> {
        for (const op of this.ops) if (await op.hasPermission(request, view)) return true
        return false
      }
      override async hasObjectPermission(request: APIRequest, view: any, obj: any): Promise<boolean> {
        for (const op of this.ops) {
          if ((await op.hasPermission(request, view)) && (await op.hasObjectPermission(request, view, obj)))
            return true
        }
        return false
      }
    },
    classes.map((c) => c.name).join('Or'),
  )
}

function composeAnd(classes: PermissionClass[]): ComposedPermission {
  return named(
    class AND extends BasePermission {
      readonly ops = classes.map((C) => new C())
      override async hasPermission(request: APIRequest, view: any): Promise<boolean> {
        for (const op of this.ops) {
          if (!(await op.hasPermission(request, view))) {
            this.message = op.message
            this.code = op.code
            return false
          }
        }
        return true
      }
      override async hasObjectPermission(request: APIRequest, view: any, obj: any): Promise<boolean> {
        for (const op of this.ops) {
          if (!(await op.hasObjectPermission(request, view, obj))) {
            this.message = op.message
            this.code = op.code
            return false
          }
        }
        return true
      }
    },
    classes.map((c) => c.name).join('And'),
  )
}

function composeNot(cls: PermissionClass): ComposedPermission {
  return named(
    class NOT extends BasePermission {
      readonly op = new cls()
      override async hasPermission(request: APIRequest, view: any): Promise<boolean> {
        return !(await this.op.hasPermission(request, view))
      }
      override async hasObjectPermission(request: APIRequest, view: any, obj: any): Promise<boolean> {
        return !(await this.op.hasObjectPermission(request, view, obj))
      }
    },
    `Not${cls.name}`,
  )
}

/** Allow everything (the default `DEFAULT_PERMISSION_CLASSES`). */
export class AllowAny extends BasePermission {
  override hasPermission(): boolean {
    return true
  }
}

/** Only authenticated users. */
export class IsAuthenticated extends BasePermission {
  override hasPermission(request: APIRequest): boolean {
    return !!request.user?.isAuthenticated
  }
}

/** Only staff users (`user.isStaff`). */
export class IsAdminUser extends BasePermission {
  override hasPermission(request: APIRequest): boolean {
    return !!request.user?.isStaff
  }
}

/** Authenticated users, or anyone for safe methods (GET / HEAD / OPTIONS). */
export class IsAuthenticatedOrReadOnly extends BasePermission {
  override hasPermission(request: APIRequest): boolean {
    return SAFE_METHODS.includes(request.method) || !!request.user?.isAuthenticated
  }
}

function permsFor(map: Record<string, string[]>, method: string, model: any): string[] | null {
  const tpl = map[method]
  if (!tpl) return null
  const meta = model._meta
  return tpl.map((p) =>
    p
      .replace(/%\(app_label\)s|\{appLabel\}/g, meta.appLabel)
      .replace(/%\(model_name\)s|\{modelName\}/g, meta.modelName),
  )
}

async function userHasPerms(user: any, perms: string[], obj?: unknown): Promise<boolean> {
  if (!perms.length) return true
  if (typeof user.hasPerms === 'function') return user.hasPerms(perms, obj)
  for (const p of perms) if (!(await user.hasPerm(p, obj))) return false
  return true
}

function viewQueryset(view: any): any {
  if (typeof view.getQueryset === 'function') {
    const qs = view.getQueryset()
    if (qs) return qs
  }
  if (view.queryset) return view.queryset
  throw new TypeError(
    'Cannot apply ModelPermissions on a view that does not set `.queryset` or have a `.getQueryset()` method.',
  )
}

/**
 * DRF's `DjangoModelPermissions`: requires `user.hasPerm('<app>.add_<model>')` for POST, `change_` for
 * PUT/PATCH and `delete_` for DELETE on the view's model. Safe methods only need authentication.
 */
export class ModelPermissions extends BasePermission {
  permsMap: Record<string, string[]> = {
    GET: [],
    OPTIONS: [],
    HEAD: [],
    POST: ['{appLabel}.add_{modelName}'],
    PUT: ['{appLabel}.change_{modelName}'],
    PATCH: ['{appLabel}.change_{modelName}'],
    DELETE: ['{appLabel}.delete_{modelName}'],
  }
  authenticatedUsersOnly = true

  getRequiredPermissions(method: string, model: any): string[] {
    const perms = permsFor(this.permsMap, method, model)
    if (perms === null) throw new MethodNotAllowed(method)
    return perms
  }

  override async hasPermission(request: APIRequest, view: any): Promise<boolean> {
    const user = request.user
    if (!user || (!user.isAuthenticated && this.authenticatedUsersOnly)) return false
    if (view._ignoreModelPermissions) return true
    const qs = viewQueryset(view)
    const perms = this.getRequiredPermissions(request.method, qs.model)
    return userHasPerms(user, perms)
  }
}

/** Like `ModelPermissions`, but anonymous users get read-only access. */
export class ModelPermissionsOrAnonReadOnly extends ModelPermissions {
  override authenticatedUsersOnly = false
}

/**
 * DRF's `DjangoObjectPermissions`: per-object permissions via `user.hasPerm(perm, obj)` (needs an object
 * permission backend). Missing read permission on an object yields 404 to avoid leaking its existence.
 */
export class ObjectPermissions extends ModelPermissions {
  override permsMap: Record<string, string[]> = {
    GET: [],
    OPTIONS: [],
    HEAD: [],
    POST: ['{appLabel}.add_{modelName}'],
    PUT: ['{appLabel}.change_{modelName}'],
    PATCH: ['{appLabel}.change_{modelName}'],
    DELETE: ['{appLabel}.delete_{modelName}'],
  }

  getRequiredObjectPermissions(method: string, model: any): string[] {
    return this.getRequiredPermissions(method, model)
  }

  override async hasObjectPermission(request: APIRequest, view: any, obj: any): Promise<boolean> {
    const qs = viewQueryset(view)
    const model = qs.model
    const user = request.user
    const perms = this.getRequiredObjectPermissions(request.method, model)
    if (await userHasPerms(user, perms, obj)) return true
    // The user lacks the permission. If they can't even read it, pretend it does not exist.
    if (SAFE_METHODS.includes(request.method)) throw new Http404()
    const readPerms = this.getRequiredObjectPermissions('GET', model)
    if (!(await userHasPerms(user, readPerms, obj))) throw new Http404()
    return false
  }
}

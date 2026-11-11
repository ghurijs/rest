import { CSRF_EXEMPT_MARKER, ImproperlyConfigured, resolverMatch, reverse } from '@ghuri/core'
import type { Context } from 'hono'
import { type ActionInfo, getExtraActions } from './decorators'
import {
  CreateModelMixin,
  DestroyModelMixin,
  GenericAPIView,
  ListModelMixin,
  RetrieveModelMixin,
  UpdateModelMixin,
} from './generics'
import type { APIRequest } from './request'
import { APIView, type APIViewFunction } from './views'

export type ActionMap = Record<string, string>
type APIViewConstructor = new (...args: any[]) => APIView

/**
 * DRF's `ViewSetMixin`: handlers are actions (`list`, `create`, `retrieve`, `update`, `partialUpdate`,
 * `destroy`, extra `@action`s) bound to HTTP methods by `asView({ get: 'list', post: 'create' })` — routers do
 * this for you. Inside a handler `this.action` is the action name.
 */
export function ViewSetMixin<TBase extends APIViewConstructor>(Base: TBase) {
  return class ViewSetMixin extends Base {
    /** Current action (`'list'`, `'retrieve'`, `'publish'`, `'metadata'` for OPTIONS…). */
    declare action?: string
    declare basename?: string
    /** True on detail routes. */
    declare detail?: boolean
    declare suffix?: string
    /** HTTP method → action for this route. */
    actionMap: ActionMap = {}

    /** Route-bound view function. */
    static asView(this: any, actions?: ActionMap, initkwargs: Record<string, unknown> = {}): APIViewFunction {
      if (!actions || !Object.keys(actions).length) {
        throw new TypeError(
          "The `actions` argument must be provided when calling `.asView()` on a ViewSet. For example `.asView({ get: 'list' })`",
        )
      }
      for (const key of Object.keys(initkwargs)) {
        if ((this.httpMethodNames as string[]).includes(key)) {
          throw new ImproperlyConfigured(
            `You tried to pass in the ${key} method name as a keyword argument to ${this.name}(). Don't do that.`,
          )
        }
      }
      if ('name' in initkwargs && 'suffix' in initkwargs) {
        throw new TypeError(
          `${this.name}.asView() received both \`name\` and \`suffix\`, which are mutually exclusive arguments.`,
        )
      }
      const view = (async (c: Context) => {
        const self = new this()
        Object.assign(self, initkwargs)
        self.actionMap = actions
        for (const [method, actionName] of Object.entries(actions)) {
          const handler = self[actionName]
          if (typeof handler === 'function') self[method] = handler
        }
        if (typeof self.get === 'function' && typeof self.head !== 'function') self.head = self.get
        return self.dispatch(c)
      }) as APIViewFunction
      view.viewClass = this
      view.cls = this
      view.initkwargs = initkwargs
      view.viewInitkwargs = initkwargs
      view.actions = actions
      Object.defineProperty(view, 'name', { value: this.name })
      ;(view as any)[CSRF_EXEMPT_MARKER] = true
      return view
    }

    override initializeRequest(c: Context): APIRequest {
      const request = super.initializeRequest(c)
      const method = c.req.method.toLowerCase()
      this.action = method === 'options' ? 'metadata' : this.actionMap[method === 'head' ? 'get' : method]
      return request
    }

    override allowedMethods(): string[] {
      const out = Object.keys(this.actionMap).map((m) => m.toUpperCase())
      if (out.includes('GET') && !out.includes('HEAD')) out.splice(out.indexOf('GET') + 1, 0, 'HEAD')
      if (typeof (this as any).options === 'function' && !out.includes('OPTIONS')) out.push('OPTIONS')
      return out.length ? out : super.allowedMethods()
    }

    /** Absolute URL of a route of this viewset: `this.reverseAction('detail', { pk: 1 })`, `'set-password'`. */
    reverseAction(urlName: string, kwargs: Record<string, unknown> = {}): string {
      let name = `${this.basename}-${urlName}`
      const ns = this.request ? resolverMatch(this.request.c)?.namespace : undefined
      if (ns) name = `${ns}:${name}`
      const path = reverse(name, kwargs)
      return this.request ? this.request.buildAbsoluteUri(path) : path
    }

    /** Extra actions declared with `@action` / `static actions` (DRF's `get_extra_actions`). */
    static getExtraActions(this: any): ActionInfo[] {
      return getExtraActions(this)
    }

    /** `{ 'Publish': 'http://…/posts/1/publish/' }` for the extra actions of this route type. */
    getExtraActionUrlMap(): Record<string, string> {
      const out: Record<string, string> = {}
      if (this.detail === undefined) return out
      for (const a of getExtraActions(this.constructor)) {
        if (a.detail !== this.detail) continue
        try {
          const kwargs = a.detail ? this.kwargs : {}
          const lookup = Object.fromEntries(Object.entries(kwargs).filter(([k]) => k !== 'format'))
          out[String(a.kwargs.name ?? a.name)] = this.reverseAction(a.urlName, lookup)
        } catch {
          // route not reversible
        }
      }
      return out
    }
  }
}

/** Base viewset without model behavior: define `list`, `retrieve`, … yourself. */
export class ViewSet extends ViewSetMixin(APIView) {}

/** Viewset with GenericAPIView helpers (`getQueryset`, `getObject`, `getSerializer`, pagination, filters). */
export class GenericViewSet extends ViewSetMixin(GenericAPIView) {}

/** `list` + `retrieve`. */
export class ReadOnlyModelViewSet<M = any> extends RetrieveModelMixin(ListModelMixin(GenericViewSet)) {
  declare __model?: M
}

/** `list`, `create`, `retrieve`, `update`, `partialUpdate`, `destroy`. */
export class ModelViewSet<M = any> extends CreateModelMixin(
  RetrieveModelMixin(UpdateModelMixin(DestroyModelMixin(ListModelMixin(GenericViewSet)))),
) {
  declare __model?: M
}

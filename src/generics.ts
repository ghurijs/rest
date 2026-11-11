import { ValidationError as CoreValidationError, ImproperlyConfigured, ObjectDoesNotExist } from '@ghuri/core'
import { NotFound } from './exceptions'
import type { FilterBackendClass } from './filters'
import type { BasePagination, PaginationClass } from './pagination'
import type { APIRequest } from './request'
import { APIResponse } from './response'
import type { BaseSerializer, SerializerOptions } from './serializers'
import { apiSettings } from './settings'
import { status } from './status'
import { isManager, isQuerySet } from './utils'
import { APIView } from './views'

export type SerializerClass = new (opts?: any) => BaseSerializer

/**
 * DRF's `GenericAPIView`: `queryset` + `serializerClass` + lookup, filtering and pagination helpers used by
 * the mixins and concrete generic views.
 */
export class GenericAPIView<M = any> extends APIView {
  /** Base queryset (`Post.objects.all()`); re-evaluated per request via `getQueryset()`. */
  declare queryset?: any
  declare serializerClass?: SerializerClass
  /** Model field used to look up single objects (default `'pk'`). */
  lookupField = 'pk'
  /** URL kwarg holding the lookup value (default: `lookupField`). */
  declare lookupUrlKwarg?: string
  /** Router: regular expression for the lookup URL segment (default `[^/.]+`). */
  declare lookupValueRegex?: string
  /** Router: core path converter for the lookup segment (`'int'`, `'uuid'`, `'slug'`…). */
  declare lookupValueConverter?: string
  declare filterBackends?: FilterBackendClass[]
  /** Pagination class; `null` disables pagination (default `DEFAULT_PAGINATION_CLASS`). */
  declare paginationClass?: PaginationClass | null
  // Options read by the built-in filter backends:
  declare searchFields?: string[]
  declare orderingFields?: string[] | '__all__'
  declare ordering?: string | string[]
  declare filtersetFields?: string[] | Record<string, string[]>
  _paginator?: BasePagination | null

  /** The queryset for this request (`this.queryset.all()`); override to filter by user, etc. */
  getQueryset(): any {
    if (this.queryset === undefined || this.queryset === null) {
      throw new ImproperlyConfigured(
        `'${this.constructor.name}' should either include a \`queryset\` attribute, or override the \`getQueryset()\` method.`,
      )
    }
    const qs = this.queryset
    if (isQuerySet(qs) || isManager(qs)) return qs.all()
    if (typeof qs === 'function' && qs._defaultManager) return qs._defaultManager.all()
    return qs
  }

  /** Lookup the object for detail routes, check object permissions; 404 when missing. */
  async getObject(): Promise<M> {
    const queryset = this.filterQueryset(this.getQueryset())
    const lookupUrlKwarg = this.lookupUrlKwarg ?? this.lookupField
    if (!(lookupUrlKwarg in this.kwargs)) {
      throw new ImproperlyConfigured(
        `Expected view ${this.constructor.name} to be called with a URL keyword argument named "${lookupUrlKwarg}". Fix your URL conf, or set the \`.lookupField\` attribute on the view correctly.`,
      )
    }
    const model = queryset.model
    const notFound = () => new NotFound(`No ${model?._meta?.objectName ?? 'object'} matches the given query.`)
    let value = this.kwargs[lookupUrlKwarg]
    const field = model?._meta?.getForwardField(
      this.lookupField === 'pk' ? model._meta.pk.name : this.lookupField,
    )
    if (field && !field.isRelation && typeof field.toPython === 'function') {
      try {
        value = field.toPython(value)
      } catch {
        throw notFound()
      }
    }
    let obj: M
    try {
      obj = await queryset.get({ [this.lookupField]: value })
    } catch (err) {
      if (
        err instanceof ObjectDoesNotExist ||
        err instanceof CoreValidationError ||
        err instanceof TypeError
      ) {
        throw notFound()
      }
      throw err
    }
    await this.checkObjectPermissions(this.request, obj)
    return obj
  }

  /** Instantiate the serializer with `context` (`{ request, format, view }`). */
  getSerializer(opts: SerializerOptions = {}): any {
    const cls = this.getSerializerClass()
    return new cls({ ...opts, context: { ...this.getSerializerContext(), ...(opts.context ?? {}) } })
  }

  getSerializerClass(): SerializerClass {
    if (!this.serializerClass) {
      throw new ImproperlyConfigured(
        `'${this.constructor.name}' should either include a \`serializerClass\` attribute, or override the \`getSerializerClass()\` method.`,
      )
    }
    return this.serializerClass
  }

  getSerializerContext(): Record<string, unknown> {
    return { request: this.request, format: this.format, view: this }
  }

  getFilterBackends(): FilterBackendClass[] {
    return this.filterBackends ?? apiSettings.DEFAULT_FILTER_BACKENDS
  }

  /** Apply every filter backend. */
  filterQueryset(queryset: any): any {
    let qs = queryset
    for (const Backend of this.getFilterBackends()) qs = new Backend().filterQueryset(this.request, qs, this)
    return qs
  }

  /** The paginator instance, or null when pagination is off. */
  get paginator(): BasePagination | null {
    if (this._paginator === undefined) {
      const cls =
        this.paginationClass !== undefined ? this.paginationClass : apiSettings.DEFAULT_PAGINATION_CLASS
      this._paginator = cls ? new cls() : null
    }
    return this._paginator
  }

  /** A page of results, or null when pagination is off. */
  async paginateQueryset(queryset: any): Promise<any[] | null> {
    const p = this.paginator
    if (!p) return null
    return p.paginateQueryset(queryset, this.request, this)
  }

  getPaginatedResponse(data: unknown): APIResponse {
    if (!this.paginator) throw new TypeError('getPaginatedResponse() called without a paginator.')
    return this.paginator.getPaginatedResponse(data)
  }
}

// ---------------------------------------------------------------------------------------------
// Mixins (class factories): `class MyView extends ListModelMixin(CreateModelMixin(GenericAPIView)) {}`
// ---------------------------------------------------------------------------------------------

export type GenericAPIViewConstructor = new (...args: any[]) => GenericAPIView

/** `create()` action: validate, `performCreate()`, 201 with `Location` when the data has a `url`. */
export function CreateModelMixin<TBase extends GenericAPIViewConstructor>(Base: TBase) {
  return class CreateModelMixin extends Base {
    async create(request: APIRequest, ..._args: any[]): Promise<APIResponse> {
      const serializer = this.getSerializer({ data: request.data })
      await serializer.isValid({ raiseException: true })
      await this.performCreate(serializer)
      const data = await serializer.getData()
      return new APIResponse(data, { status: status.HTTP_201_CREATED, headers: this.getSuccessHeaders(data) })
    }

    /** Override to pass extra values: `await serializer.save({ author: this.request.user })`. */
    async performCreate(serializer: any): Promise<void> {
      await serializer.save()
    }

    getSuccessHeaders(data: any): Record<string, string> {
      const url = data?.[apiSettings.URL_FIELD_NAME]
      return typeof url === 'string' && url ? { Location: url } : {}
    }
  }
}

/** `list()` action: filtered, paginated queryset. */
export function ListModelMixin<TBase extends GenericAPIViewConstructor>(Base: TBase) {
  return class ListModelMixin extends Base {
    async list(_request: APIRequest, ..._args: any[]): Promise<APIResponse> {
      const queryset = this.filterQueryset(this.getQueryset())
      const page = await this.paginateQueryset(queryset)
      if (page !== null) {
        const serializer = this.getSerializer({ instance: page, many: true })
        return this.getPaginatedResponse(await serializer.getData())
      }
      const serializer = this.getSerializer({ instance: queryset, many: true })
      return new APIResponse(await serializer.getData())
    }
  }
}

/** `retrieve()` action. */
export function RetrieveModelMixin<TBase extends GenericAPIViewConstructor>(Base: TBase) {
  return class RetrieveModelMixin extends Base {
    async retrieve(_request: APIRequest, ..._args: any[]): Promise<APIResponse> {
      const instance = await this.getObject()
      const serializer = this.getSerializer({ instance })
      return new APIResponse(await serializer.getData())
    }
  }
}

/** `update()` (PUT) and `partialUpdate()` (PATCH) actions. */
export function UpdateModelMixin<TBase extends GenericAPIViewConstructor>(Base: TBase) {
  return class UpdateModelMixin extends Base {
    async update(request: APIRequest, _kwargs?: Record<string, any>, partial = false): Promise<APIResponse> {
      const instance = await this.getObject()
      const serializer = this.getSerializer({ instance, data: request.data, partial })
      await serializer.isValid({ raiseException: true })
      await this.performUpdate(serializer)
      return new APIResponse(await serializer.getData())
    }

    async performUpdate(serializer: any): Promise<void> {
      await serializer.save()
    }

    async partialUpdate(request: APIRequest, kwargs?: Record<string, any>): Promise<APIResponse> {
      return this.update(request, kwargs, true)
    }
  }
}

/** `destroy()` action: 204. */
export function DestroyModelMixin<TBase extends GenericAPIViewConstructor>(Base: TBase) {
  return class DestroyModelMixin extends Base {
    async destroy(_request: APIRequest, ..._args: any[]): Promise<APIResponse> {
      const instance = await this.getObject()
      await this.performDestroy(instance)
      return new APIResponse(null, { status: status.HTTP_204_NO_CONTENT })
    }

    async performDestroy(instance: any): Promise<void> {
      await instance.delete()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Concrete generic views
// ---------------------------------------------------------------------------------------------

/** POST → create. */
export class CreateAPIView extends CreateModelMixin(GenericAPIView) {
  async post(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.create(request, kwargs)
  }
}

/** GET → list. */
export class ListAPIView extends ListModelMixin(GenericAPIView) {
  async get(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.list(request, kwargs)
  }
}

/** GET → retrieve. */
export class RetrieveAPIView extends RetrieveModelMixin(GenericAPIView) {
  async get(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.retrieve(request, kwargs)
  }
}

/** DELETE → destroy. */
export class DestroyAPIView extends DestroyModelMixin(GenericAPIView) {
  async delete(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.destroy(request, kwargs)
  }
}

/** PUT → update, PATCH → partialUpdate. */
export class UpdateAPIView extends UpdateModelMixin(GenericAPIView) {
  async put(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.update(request, kwargs)
  }
  async patch(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.partialUpdate(request, kwargs)
  }
}

/** GET → list, POST → create. */
export class ListCreateAPIView extends ListModelMixin(CreateModelMixin(GenericAPIView)) {
  async get(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.list(request, kwargs)
  }
  async post(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.create(request, kwargs)
  }
}

/** GET → retrieve, PUT / PATCH → update. */
export class RetrieveUpdateAPIView extends RetrieveModelMixin(UpdateModelMixin(GenericAPIView)) {
  async get(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.retrieve(request, kwargs)
  }
  async put(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.update(request, kwargs)
  }
  async patch(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.partialUpdate(request, kwargs)
  }
}

/** GET → retrieve, DELETE → destroy. */
export class RetrieveDestroyAPIView extends RetrieveModelMixin(DestroyModelMixin(GenericAPIView)) {
  async get(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.retrieve(request, kwargs)
  }
  async delete(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.destroy(request, kwargs)
  }
}

/** GET → retrieve, PUT / PATCH → update, DELETE → destroy. */
export class RetrieveUpdateDestroyAPIView extends RetrieveModelMixin(
  UpdateModelMixin(DestroyModelMixin(GenericAPIView)),
) {
  async get(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.retrieve(request, kwargs)
  }
  async put(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.update(request, kwargs)
  }
  async patch(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.partialUpdate(request, kwargs)
  }
  async delete(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    return this.destroy(request, kwargs)
  }
}

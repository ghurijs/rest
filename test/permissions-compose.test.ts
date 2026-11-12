// `.and()` / `.or()` / `.not()` return classes that compose further (types and behavior).
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type APIRequest,
  BasePermission,
  type ComposedPermission,
  IsAdminUser,
  IsAuthenticated,
  type PermissionClass,
} from '../src/index'

class IsStaff extends BasePermission {
  override hasPermission(request: APIRequest) {
    return request.user.isStaff === true
  }
}

const req = (user: Record<string, unknown>) => ({ user, method: 'GET' }) as unknown as APIRequest

describe('composed permissions', () => {
  it('chain: IsAuthenticated.and(IsStaff).or(IsAdminUser).not()', async () => {
    const Chained = IsAuthenticated.and(IsStaff).or(IsAdminUser)
    expectTypeOf(Chained).toEqualTypeOf<ComposedPermission>()
    expectTypeOf(Chained).toMatchTypeOf<PermissionClass>()
    expectTypeOf(Chained.not().and(IsStaff)).toEqualTypeOf<ComposedPermission>()

    const staff = req({ isAuthenticated: true, isStaff: true })
    const plain = req({ isAuthenticated: true, isStaff: false })
    expect(await new Chained().hasPermission(staff, null)).toBe(true)
    expect(await new Chained().hasPermission(plain, null)).toBe(false)
    expect(await new (Chained.not())().hasPermission(plain, null)).toBe(true)
    const permissionClasses: PermissionClass[] = [IsAuthenticated.and(IsStaff).or(IsAdminUser)]
    expect(permissionClasses[0].name).toBe('IsAuthenticatedAndIsStaffOrIsAdminUser')
  })
})

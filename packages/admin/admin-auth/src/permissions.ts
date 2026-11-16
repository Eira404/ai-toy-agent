import { AdminAuthError } from "./error.js"
import type { AdminPermission, AdminRole } from "./types.js"

export const ADMIN_ROLES = ["superadmin", "admin", "viewer"] as const
export const ADMIN_PERMISSIONS = [
  "admins.read",
  "admins.create",
  "admins.manage",
  "admins.roles",
  "sessions.cleanup",
] as const

const permissions: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  superadmin: ADMIN_PERMISSIONS,
  admin: ["admins.read", "admins.create", "admins.manage"],
  viewer: ["admins.read"],
}

export function isAdminRole(value: unknown): value is AdminRole {
  return value === "superadmin" || value === "admin" || value === "viewer"
}

/** 纯权限表查询，不验证身份；实际入口应调用 ctx.adminAuth.authorize 或具体管理方法。 */
export function hasAdminPermission(role: AdminRole, permission: AdminPermission): boolean {
  return isAdminRole(role) && permissions[role].includes(permission)
}

export function assertPermission(role: AdminRole, permission: AdminPermission): void {
  if (!ADMIN_PERMISSIONS.includes(permission)) {
    throw new AdminAuthError("invalid-input", "未知管理员权限")
  }
  if (!hasAdminPermission(role, permission)) {
    throw new AdminAuthError("forbidden", "当前管理员没有此操作权限")
  }
}

/** 普通管理员只能创建/启停/强制下线只读账号，不能管理同级或超级管理员。 */
export function assertCanManage(role: AdminRole, targetRole: AdminRole): void {
  assertPermission(role, "admins.manage")
  if (role !== "superadmin" && targetRole !== "viewer") {
    throw new AdminAuthError("forbidden", "普通管理员只能管理只读账号")
  }
}

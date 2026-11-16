export { AdminAuth, AdminAuth as default } from "./service.js"
export { AdminAuthError } from "./error.js"
export type { AdminAuthErrorCode } from "./error.js"
export { ADMIN_ROLES, ADMIN_PERMISSIONS, hasAdminPermission } from "./permissions.js"
export {
  adminAuthRelationalSchema,
  ADMIN_ACCOUNTS_TABLE,
  ADMIN_SESSIONS_TABLE,
  ADMIN_AUTH_STATE_TABLE,
  ADMIN_SECURITY_EVENTS_TABLE,
} from "./schema.js"
export type {
  AdminAuthConfig,
  AdminRole,
  AdminPermission,
  AdminProfile,
  AdminIdentity,
  CreateAdminInput,
  LoginInput,
  LoginResult,
  ChangePasswordInput,
  ListAdminsInput,
  AdminCursor,
  AdminPage,
  AdminSecurityAction,
  AdminSecurityOutcome,
} from "./types.js"

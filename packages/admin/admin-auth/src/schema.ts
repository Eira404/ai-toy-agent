import type { RelationalSchemaDefinition } from "toy-storage-relational"

export const ADMIN_ACCOUNTS_TABLE = "toy_admin_accounts"
export const ADMIN_SESSIONS_TABLE = "toy_admin_sessions"
export const ADMIN_AUTH_STATE_TABLE = "toy_admin_auth_state"
export const ADMIN_SECURITY_EVENTS_TABLE = "toy_admin_security_events"

/** 宿主须将全部表与唯一索引合并到关系型 adapter 的 schema。 */
export const adminAuthRelationalSchema = {
  tables: {
    [ADMIN_ACCOUNTS_TABLE]: {
      primaryKey: "admin_id",
      columns: {
        admin_id: { type: "string" },
        login_name: { type: "string" },
        display_name: { type: "string" },
        role: { type: "string" },
        password_hash: { type: "string" },
        enabled: { type: "boolean" },
        security_version: { type: "integer" },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
        password_changed_at: { type: "datetime" },
      },
      indexes: [
        { name: "admin_login_name", fields: ["login_name"], unique: true },
        { name: "admin_created", fields: ["created_at", "admin_id"] },
      ],
    },
    [ADMIN_SESSIONS_TABLE]: {
      primaryKey: "session_id",
      columns: {
        session_id: { type: "string" },
        admin_id: { type: "string" },
        token_digest: { type: "string" },
        security_version: { type: "integer" },
        created_at: { type: "datetime" },
        expires_at: { type: "datetime" },
        revoked_at: { type: "datetime", nullable: true },
      },
      indexes: [
        { name: "admin_session_token", fields: ["token_digest"], unique: true },
        { name: "admin_session_owner", fields: ["admin_id"] },
        { name: "admin_session_expiry", fields: ["expires_at"] },
      ],
    },
    [ADMIN_AUTH_STATE_TABLE]: {
      primaryKey: "state_id",
      columns: {
        state_id: { type: "string" },
        bootstrapped: { type: "boolean" },
        lock_token: { type: "string" },
      },
    },
    [ADMIN_SECURITY_EVENTS_TABLE]: {
      primaryKey: "event_id",
      columns: {
        event_id: { type: "string" },
        action: { type: "string" },
        outcome: { type: "string" },
        actor_id: { type: "string", nullable: true },
        target_id: { type: "string", nullable: true },
        subject_digest: { type: "string", nullable: true },
        occurred_at: { type: "datetime" },
      },
      indexes: [{ name: "admin_login_attempts", fields: ["subject_digest", "occurred_at"] }],
    },
  },
} as const satisfies RelationalSchemaDefinition

import { createHash, randomBytes } from "node:crypto"
import { AdminAuthError } from "./error.js"

export function newToken(): string {
  return randomBytes(32).toString("base64url")
}

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function tokenDigest(token: unknown): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new AdminAuthError("unauthenticated", "登录凭据无效或已失效")
  }
  return digest(token)
}

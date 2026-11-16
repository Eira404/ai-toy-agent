import { Service, type Context } from "cordis"
import "toy-backend-http"
import type {
  CreateUserInput,
  EnsureUserResult,
  ListUsersInput,
  Page,
  UpdateUserInput,
  UserCursor,
  UserRecord,
} from "toy-debug-user"
import type {
  CreateDeviceInput,
  DeviceCursor,
  DeviceRecord,
  EnsureDeviceResult,
  ListDevicesInput,
  UpdateDeviceInput,
} from "toy-debug-device"

declare module "cordis" {
  interface Context {
    debugBackend: DebugBackendService
  }
}

/**
 * Debug 后端门面：把 `ctx.debugUsers` / `ctx.debugDevices` 的 debug 操作收敛成
 * `/debug/*` 的 HTTP 路由，注册到 `toy-backend-http`。
 *
 * 它只转发 debug 存储服务，不建根 Context、不编排；依赖通过 `inject` 声明，
 * 由开发者负责按序挂载（需先挂载 `DebugUsers`、`DebugDevices` 和 `HttpServer`）。
 */
export class DebugBackendService extends Service {
  static inject = ["debugUsers", "debugDevices", "http"]

  constructor(ctx: Context) {
    super(ctx, "debugBackend")
    ctx.effect(() => this.registerRoutes(), "debugBackend.routes")
  }

  createUser(input: CreateUserInput): Promise<UserRecord> {
    return this.ctx.debugUsers.createUser(input)
  }

  ensureUser(input: CreateUserInput): Promise<EnsureUserResult> {
    return this.ctx.debugUsers.ensureUser(input)
  }

  seedUsers(inputs: readonly CreateUserInput[]): Promise<readonly EnsureUserResult[]> {
    return this.ctx.debugUsers.seedUsers(inputs)
  }

  getUser(userId: string): Promise<UserRecord | undefined> {
    return this.ctx.debugUsers.getUser(userId)
  }

  listUsers(input: ListUsersInput): Promise<Page<UserRecord, UserCursor>> {
    return this.ctx.debugUsers.listUsers(input)
  }

  updateUser(userId: string, patch: UpdateUserInput): Promise<UserRecord> {
    return this.ctx.debugUsers.updateUser(userId, patch)
  }

  deleteUser(userId: string): Promise<boolean> {
    return this.ctx.debugUsers.deleteUser(userId)
  }

  createDevice(input: CreateDeviceInput): Promise<DeviceRecord> {
    return this.ctx.debugDevices.createDevice(input)
  }

  ensureDevice(input: CreateDeviceInput): Promise<EnsureDeviceResult> {
    return this.ctx.debugDevices.ensureDevice(input)
  }

  seedDevices(inputs: readonly CreateDeviceInput[]): Promise<readonly EnsureDeviceResult[]> {
    return this.ctx.debugDevices.seedDevices(inputs)
  }

  getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.ctx.debugDevices.getDevice(deviceId)
  }

  listDevices(input: ListDevicesInput): Promise<Page<DeviceRecord, DeviceCursor>> {
    return this.ctx.debugDevices.listDevices(input)
  }

  updateDevice(deviceId: string, patch: UpdateDeviceInput): Promise<DeviceRecord> {
    return this.ctx.debugDevices.updateDevice(deviceId, patch)
  }

  deleteDevice(deviceId: string): Promise<boolean> {
    return this.ctx.debugDevices.deleteDevice(deviceId)
  }

  /** 把门面接口注册为 `/debug/*` 的 HTTP 路由；卸载时一并注销。 */
  private registerRoutes(): () => void {
    const { http } = this.ctx
    const disposers = [
      http.post("/debug/createUser", (c) => this.createUser(c.body as CreateUserInput)),
      http.post("/debug/ensureUser", (c) => this.ensureUser(c.body as CreateUserInput)),
      http.post("/debug/seedUsers", (c) => this.seedUsers(c.body as CreateUserInput[])),
      http.get("/debug/getUser/:userId", (c) => this.getUser(c.params.userId!)),
      http.get("/debug/listUsers", (c) => {
        const limit = parseQueryInt(c.query, "limit")
        const beforeCreatedAt = c.query.get("beforeCreatedAt")
        const beforeUserId = c.query.get("beforeUserId")
        return this.listUsers({
          ...(limit === undefined ? {} : { limit }),
          ...(beforeCreatedAt === null || beforeUserId === null
            ? {}
            : { before: { createdAt: beforeCreatedAt, userId: beforeUserId } }),
        })
      }),
      http.post("/debug/updateUser/:userId", (c) =>
        this.updateUser(c.params.userId!, c.body as UpdateUserInput),
      ),
      http.delete("/debug/deleteUser/:userId", (c) => this.deleteUser(c.params.userId!)),

      http.post("/debug/createDevice", (c) => this.createDevice(c.body as CreateDeviceInput)),
      http.post("/debug/ensureDevice", (c) => this.ensureDevice(c.body as CreateDeviceInput)),
      http.post("/debug/seedDevices", (c) => this.seedDevices(c.body as CreateDeviceInput[])),
      http.get("/debug/getDevice/:deviceId", (c) => this.getDevice(c.params.deviceId!)),
      http.get("/debug/listDevices", (c) => {
        const userId = c.query.get("userId")
        const limit = parseQueryInt(c.query, "limit")
        const beforeCreatedAt = c.query.get("beforeCreatedAt")
        const beforeDeviceId = c.query.get("beforeDeviceId")
        return this.listDevices({
          ...(userId === null ? {} : { userId }),
          ...(limit === undefined ? {} : { limit }),
          ...(beforeCreatedAt === null || beforeDeviceId === null
            ? {}
            : { before: { createdAt: beforeCreatedAt, deviceId: beforeDeviceId } }),
        })
      }),
      http.post("/debug/updateDevice/:deviceId", (c) =>
        this.updateDevice(c.params.deviceId!, c.body as UpdateDeviceInput),
      ),
      http.delete("/debug/deleteDevice/:deviceId", (c) => this.deleteDevice(c.params.deviceId!)),
    ]
    return () => {
      for (const dispose of disposers) {
        dispose()
      }
    }
  }
}

/** 解析整数查询参数；缺失或非法时返回 undefined。 */
function parseQueryInt(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

export default DebugBackendService

import { Service, type Context } from "cordis"
import "toy-backend-http"
import "toy-memory-space"
import "toy-memory-fast"
import "toy-memory-long"
import "toy-memory-daily"
import type { ListFastInput, RunEmbeddingJobsOptions, Scope } from "toy-memory-fast"
import type { LifecycleStatus, ListLongInput, LongDomain } from "toy-memory-long"
import type { BindDeviceInput, CreateSpaceInput } from "toy-memory-space"

declare module "cordis" {
  interface Context {
    memoryBackend: MemoryBackendService
  }
}

/**
 * 记忆后端门面：把 `toy-memory-space` / `toy-memory-fast` / `toy-memory-long` /
 * `toy-memory-daily` 的运维、查看与手动 Dream 触发收敛成 `/memory/*` HTTP 路由。
 *
 * 只转发、不编排、不解析全局配置；依赖通过 `inject` 声明，由开发者按序挂载。
 */
export class MemoryBackendService extends Service {
  static inject = ["http", "memorySpace", "memoryFast", "memoryLong", "memoryDaily"]

  constructor(ctx: Context) {
    super(ctx, "memoryBackend")
    ctx.effect(() => this.registerRoutes(), "memoryBackend.routes")
  }

  private registerRoutes(): () => void {
    const { http, memorySpace, memoryFast, memoryLong, memoryDaily } = this.ctx
    const disposers = [
      // ---- 记忆空间（运维） ----
      http.post("/memory/spaces", (c) => memorySpace.createSpace(c.body as CreateSpaceInput)),
      http.get("/memory/spaces", (c) => {
        const includeDeleted = c.query.get("includeDeleted") === "true"
        const userId = c.query.get("userId")
        if (userId === null || c.query.get("all") === "true") {
          return memorySpace.listAllSpaces(includeDeleted ? { includeDeleted: true } : {})
        }
        return memorySpace.listSpaces(userId, includeDeleted ? { includeDeleted: true } : {})
      }),
      http.get("/memory/spaces/:spaceId", (c) => memorySpace.getSpace(c.params.spaceId!)),
      http.post("/memory/spaces/:spaceId/rename", (c) =>
        memorySpace.renameSpace(bodyOf(c).userId, c.params.spaceId!, bodyOf(c).name ?? ""),
      ),
      http.post("/memory/spaces/:spaceId/delete", (c) =>
        memorySpace.deleteSpace(bodyOf(c).userId, c.params.spaceId!),
      ),
      http.post("/memory/spaces/:spaceId/restore", (c) =>
        memorySpace.restoreSpace(bodyOf(c).userId, c.params.spaceId!),
      ),
      http.post("/memory/spaces/:spaceId/bind", (c) =>
        memorySpace.bindDevice({
          userId: bodyOf(c).userId,
          deviceId: bodyOf(c).deviceId,
          memorySpaceId: c.params.spaceId!,
        } satisfies BindDeviceInput),
      ),
      http.delete("/memory/spaces/:spaceId/bind", (c) =>
        memorySpace.unbindDevice(c.query.get("userId") ?? "", c.query.get("deviceId") ?? ""),
      ),
      http.get("/memory/spaces/:spaceId/devices", (c) =>
        memorySpace.listBoundDevices(c.params.spaceId!),
      ),

      // ---- Fast 证据（查看 + 运维） ----
      http.get("/memory/fast/list", (c) => memoryFast.listBySpace(fastListInput(c))),
      http.get("/memory/fast/count", (c) => memoryFast.countBySpace(scopeOf(c))),
      http.post("/memory/fast/embedding-jobs", (c) => memoryFast.runEmbeddingJobs(runEmbeddingJobsInput(c))),

      // ---- Long 长期记忆（查看） ----
      http.get("/memory/long/list", (c) => memoryLong.listBySpace(longListInput(c))),
      http.get("/memory/long/count", (c) => memoryLong.countBlocks(scopeOf(c))),
      http.get("/memory/long/:blockId", (c) => memoryLong.getBlock(scopeOf(c), c.params.blockId!)),

      // ---- Daily Dream（手动触发） ----
      http.post("/memory/daily/run", (c) => memoryDaily.runDaily(c.body as Scope)),
    ]
    return () => {
      for (const dispose of disposers) {
        dispose()
      }
    }
  }
}

/** 请求体按 any 处理，字段由业务校验。 */
function bodyOf(c: { body: unknown }): any {
  return c.body
}

/** 从查询串解析记忆范围（宿主已校验的 userId + memorySpaceId）。 */
function scopeOf(c: { query: URLSearchParams }): Scope {
  return {
    userId: c.query.get("userId") ?? "",
    memorySpaceId: c.query.get("memorySpaceId") ?? "",
  }
}

function fastListInput(c: { query: URLSearchParams }): ListFastInput {
  const scope = scopeOf(c)
  const limit = parseIntQuery(c.query, "limit")
  const beforeCreatedAt = c.query.get("beforeCreatedAt")
  const beforeFastId = c.query.get("beforeFastId")
  return {
    scope,
    ...(limit === undefined ? {} : { limit }),
    ...(c.query.get("pendingOnly") === "true" ? { pendingOnly: true } : {}),
    ...(beforeCreatedAt === null || beforeFastId === null
      ? {}
      : { before: { createdAt: beforeCreatedAt, fastId: beforeFastId } }),
  }
}

function runEmbeddingJobsInput(c: { query: URLSearchParams; body: any }): RunEmbeddingJobsOptions {
  const userId = c.body?.userId ?? c.query.get("userId")
  const memorySpaceId = c.body?.memorySpaceId ?? c.query.get("memorySpaceId")
  if (userId && memorySpaceId) {
    return { scope: { userId, memorySpaceId } }
  }
  return {}
}

function longListInput(c: { query: URLSearchParams }): ListLongInput {
  const scope = scopeOf(c)
  const limit = parseIntQuery(c.query, "limit")
  const domain = c.query.get("domain")
  const lifecycle = c.query.get("lifecycle")
  const orderBy = c.query.get("orderBy")
  const beforeSortAt = c.query.get("beforeSortAt")
  const beforeBlockId = c.query.get("beforeBlockId")
  return {
    scope,
    ...(limit === undefined ? {} : { limit }),
    ...(domain === null ? {} : { domain: domain as LongDomain }),
    ...(lifecycle === null ? {} : { lifecycle: lifecycle as LifecycleStatus }),
    ...(orderBy === null ? {} : { orderBy: orderBy as "updatedAt" | "createdAt" }),
    ...(beforeSortAt === null || beforeBlockId === null
      ? {}
      : { before: { sortAt: beforeSortAt, blockId: beforeBlockId } }),
  }
}

function parseIntQuery(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

export default MemoryBackendService

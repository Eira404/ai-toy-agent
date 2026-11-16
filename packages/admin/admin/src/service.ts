import { Service, type Context } from "cordis"
import "toy-admin-auth"
import "toy-storage"
import "toy-storage-relational"
import type { RelationalAdapter } from "toy-storage-relational"
import { AdminAudit } from "./audit.js"
import { resolveConfig } from "./config.js"
import { AdminError } from "./error.js"
import { ExecutionEngine } from "./execution.js"
import { Inflight } from "./inflight.js"
import { OperationRegistry } from "./registry.js"
import type {
  AdminConfig,
  AdminExecuteOptions,
  AdminOperationDefinition,
  AdminOperationDescription,
  AdminRegistrySnapshot,
  AdminWaitOptions,
} from "./types.js"
import { freezeDeep, text } from "./validation.js"

declare module "cordis" {
  interface Context {
    admin: Admin
  }
  interface Events {
    /** 路由同步通知，不是权限钩子；revision 可用于丢弃乱序完成的旧通知。 */
    "admin/operations-changed": (snapshot: AdminRegistrySnapshot) => void | Promise<void>
  }
}

/**
 * 管理员总包：能力目录、认证授权、参数校验、业务分发和调用审计。
 * 用法：先挂载 admin-auth 和带 adminRelationalSchema 的存储，再 ctx.plugin(Admin)。
 * 不创建网络接口，不解释绑定路径，不执行任务调度或驱动进度源。
 */
export class Admin extends Service {
  static inject = ["adminAuth", "storage", "storageRelational"]
  private readonly registry: OperationRegistry
  private readonly engine: ExecutionEngine
  private readonly audit: AdminAudit
  private readonly sourceName: string
  private source: RelationalAdapter | undefined
  private disposed = false

  /** @param ctx 已挂载认证与关系型存储的上下文。 @param config 命名数据源、大小/并发/等待上限。 */
  constructor(ctx: Context, config: AdminConfig = {}) {
    super(ctx, "admin")
    const resolved = resolveConfig(config)
    this.sourceName = resolved.sourceName
    const now = (): string => {
      const value = resolved.now()
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        throw new AdminError("invalid-input", "now 必须返回有效时间字符串")
      }
      return new Date(value).toISOString()
    }
    this.registry = new OperationRegistry(resolved, (snapshot) => {
      // 监听器异常不回滚已完成的注册，不输出可能带秘密的原始异常。
      void this.ctx
        .parallel("admin/operations-changed", snapshot)
        .catch(() => this.ctx.logger.warn("管理员能力变更监听器失败，请从最新快照重新同步"))
    })
    this.audit = new AdminAudit(() => this.requireSource(), now)
    this.engine = new ExecutionEngine(
      this.registry,
      new Inflight(resolved.maxConcurrentExecutions),
      this.audit,
      resolved,
      (token) => this.ctx.adminAuth.authenticate(token),
      now,
      (id, code) => this.ctx.logger.warn("管理调用在等待结束后未成功结算：%s (%s)", id, code),
    )
    ctx.effect(
      () => () => {
        this.disposed = true
        this.engine.inflight.close()
        this.registry.close()
        // 在途业务仍需记录最终状态；宿主必须先 stop + waitForIdle，再卸载存储。
      },
      "admin.dispose",
    )
  }

  /** 核对审计逻辑表，不连接数据库、不自动建表或执行迁移。 */
  [Service.init](): void {
    const source = this.ctx.storage.tryGet<RelationalAdapter>("relational", this.sourceName)
    if (source === undefined) {
      throw new AdminError("source-not-ready", "管理员审计关系型实例尚未就绪")
    }
    this.audit.initialize(source)
    this.source = source
  }

  /**
   * 注册能力，返回幂等注销函数。通过提供方 ctx.effect 绑定生命周期。
   * @param definition 稳定名称、角色、业务输入 Schema、绑定元数据与业务回调。
   * @returns 注销本代注册项的函数；不会删除后来同名的新注册项。
   * @example ctx.effect(() => ctx.admin.register({ ...definition }))
   */
  register<I = unknown, O = unknown>(definition: AdminOperationDefinition<I, O>): () => void {
    this.assertAvailable()
    return this.registry.register(definition)
  }

  /**
   * 统一管理调用入口；原始凭据仅用于认证，不传给业务插件。
   * @param name 已注册能力名。
   * @param options Token、业务 DTO、可选关联 ID/取消信号/注册代次。
   * @returns 普通 JSON 结果或声明为 opaque 的原始业务句柄。
   * @throws AdminError 含 executionId 和业务执行状态；超时/审计异常不能被视为回滚。
   */
  async execute<O = unknown, I = unknown>(
    name: string,
    options: AdminExecuteOptions<I>,
  ): Promise<O> {
    this.assertAvailable()
    return this.engine.execute<I, O>(name, options)
  }

  /** @param token 每次重新认证；结果只按角色过滤，具体资源权限在实际 execute 时检查。 */
  async listOperations(token: string): Promise<readonly AdminOperationDescription[]> {
    this.assertAvailable()
    const identity = await this.ctx.adminAuth.authenticate(token)
    return freezeDeep(
      this.registry
        .snapshot()
        .operations.filter((operation) => operation.roles.includes(identity.admin.role)),
    )
  }

  /** 查单项描述；对角色不可见返回 forbidden，不把元数据作为下一次执行的授权凭据。 */
  async describeOperation(token: string, name: string): Promise<AdminOperationDescription> {
    this.assertAvailable()
    const identity = await this.ctx.adminAuth.authenticate(token)
    const operation = this.registry.get(text(name, "name"))?.description
    if (operation === undefined) {
      throw new AdminError("operation-not-found", "管理能力不存在")
    }
    if (!operation.roles.includes(identity.admin.role)) {
      throw new AdminError("forbidden", "当前角色无法查看此能力")
    }
    return operation
  }

  /** 可信 backend 读取完整元数据，无认证；禁止将本方法直接暴露为客户端接口。 */
  getRegistrySnapshot(): AdminRegistrySnapshot {
    return this.registry.snapshot()
  }

  /** 永久停止接收新 execute，保留在途调用；宿主应停止网络接入后调用。 */
  stop(): void {
    this.engine.inflight.stop()
  }

  /** 等待尚未返回的业务调用及审计；不等待已返回任务 ID 的任务或 opaque 事件源。 */
  async waitForIdle(options: AdminWaitOptions = {}): Promise<void> {
    await this.engine.inflight.waitForIdle(options)
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new AdminError("operation-unavailable", "管理员插件已卸载")
    }
    this.requireSource()
  }

  private requireSource(): RelationalAdapter {
    if (this.source === undefined) {
      throw new AdminError("source-not-ready", "管理员审计存储尚未初始化")
    }
    return this.source
  }
}

export default Admin

import { Service, type Context } from "cordis"
import { StorageError } from "./error.js"
import { assertStorageIdentity, storageIdentityKey } from "./identity.js"
import type { StorageDescriptor, StorageEntry, StorageRegistration } from "./types.js"

declare module "cordis" {
  interface Context {
    storage: ToyStorage
  }
}

/**
 * 通用存储实例注册中心。后端插件注册实际实例，业务插件按 kind + name 查找。
 * 本服务不执行 CRUD，也不接管后端连接的关闭；连接由所属后端插件释放。
 */
export class ToyStorage extends Service {
  private readonly entries = new Map<string, StorageEntry>()

  constructor(ctx: Context) {
    super(ctx, "storage")
  }

  /**
   * 注册一个已就绪的存储实例；注册跟随调用方的 Cordis Fiber 自动释放。
   *
   * @param kind 存储能力类别，例如 relational。
   * @param name 同类别内唯一的业务名称，例如 main。
   * @param instance 由后端插件创建并负责关闭的实例。
   * @returns 可提前撤销本次注册的函数。
   * @throws {StorageError} 标识非法或同类型同名实例已注册时抛出。
   */
  register<T extends object>(kind: string, name: string, instance: T): StorageRegistration {
    assertStorageIdentity(kind, "kind")
    assertStorageIdentity(name, "name")
    if (instance === null || (typeof instance !== "object" && typeof instance !== "function")) {
      throw new StorageError("invalid-instance", "存储实例必须是对象或类实例")
    }
    const key = storageIdentityKey(kind, name)
    if (this.entries.has(key)) {
      throw new StorageError("duplicate-source", `存储实例 '${kind}/${name}' 已注册`)
    }

    const entry: StorageEntry<T> = { kind, name, instance }
    // effect 把注册及反注册绑定到调用方插件；旧 disposer 不会删除后来注册的新实例。
    const disposeEffect = this.ctx.effect(() => {
      this.entries.set(key, entry)
      return () => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key)
        }
      }
    }, "storage.register")
    return () => {
      void disposeEffect()
    }
  }

  /**
   * 按类型和名称查找实例。
   *
   * @param kind 存储能力类别。
   * @param name 实例业务名称。
   * @returns 匹配的实例；泛型由调用方根据 kind 的协议指定。
   * @throws {StorageError} 未注册时抛出。
   */
  get<T extends object = object>(kind: string, name: string): T {
    const instance = this.tryGet<T>(kind, name)
    if (instance === undefined) {
      throw new StorageError("source-not-found", `存储实例 '${kind}/${name}' 未注册`)
    }
    return instance
  }

  /**
   * 可选查找存储实例。
   *
   * @param kind 存储能力类别。
   * @param name 实例业务名称。
   * @returns 已注册实例，未注册时返回 undefined。
   */
  tryGet<T extends object = object>(kind: string, name: string): T | undefined {
    assertStorageIdentity(kind, "kind")
    assertStorageIdentity(name, "name")
    return this.entries.get(storageIdentityKey(kind, name))?.instance as T | undefined
  }

  /**
   * 判断一个实例当前是否已注册。
   *
   * @param kind 存储能力类别。
   * @param name 实例业务名称。
   * @returns 已注册时为 true。
   */
  has(kind: string, name: string): boolean {
    return this.tryGet(kind, name) !== undefined
  }

  /**
   * 返回注册信息快照；不暴露连接和可变的内部 Map。
   *
   * @param kind 可选的存储能力类别过滤器。
   * @returns 按注册顺序排列的类型与名称列表。
   */
  list(kind?: string): readonly StorageDescriptor[] {
    if (kind !== undefined) {
      assertStorageIdentity(kind, "kind")
    }
    return [...this.entries.values()]
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map(({ kind: entryKind, name }) => ({ kind: entryKind, name }))
  }
}

export default ToyStorage

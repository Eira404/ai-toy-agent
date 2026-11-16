import { Service, type Context } from "cordis"
import { assertOperation } from "./operation.js"
import {
  defineSchema,
  requireCollection,
  type VectorCollectionDefinition,
  type VectorSchemaDefinition,
} from "./schema.js"

declare module "cordis" {
  interface Context {
    storageVector: VectorStorage
  }
}

/** 向量存储协议的 Cordis 类插件，负责声明和校验逻辑集合与操作。 */
export class VectorStorage extends Service {
  constructor(ctx: Context) {
    super(ctx, "storageVector")
  }

  /**
   * 校验逻辑集合、向量维度、距离度量和过滤字段声明。
   *
   * @param schema 一个数据源使用的逻辑 Schema。
   * @returns 校验后的原对象，保留集合和字段的字面量类型。
   * @throws {VectorError} Schema 结构或集合约束非法时抛出。
   */
  defineSchema<const S extends VectorSchemaDefinition>(schema: S): S {
    return defineSchema(schema)
  }

  /**
   * 从已校验的 Schema 读取集合约束，供 adapter 执行读写或检索。
   *
   * @param schema 已校验的逻辑 Schema。
   * @param name 目标集合名。
   * @returns 对应集合的逻辑定义。
   * @throws {VectorError} 集合没有声明时抛出 collection-not-found。
   */
  requireCollection(schema: VectorSchemaDefinition, name: string): VectorCollectionDefinition {
    return requireCollection(schema, name)
  }

  /**
   * 校验一个操作能否在指定集合上执行，适用于入队前或 adapter 的执行入口。
   *
   * @param schema 已校验的逻辑 Schema。
   * @param operation 待校验的操作数据。
   * @throws {VectorError} 集合未知或操作违反集合约束时抛出。
   */
  assertOperation(schema: VectorSchemaDefinition, operation: unknown): void {
    assertOperation(schema, operation)
  }
}

export default VectorStorage

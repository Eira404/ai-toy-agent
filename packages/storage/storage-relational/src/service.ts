import { Service, type Context } from "cordis"
import { assertRelationalFilter, type RelationalFilter } from "./filter.js"
import { isJsonValue, type JsonValue, type RelationalRecord } from "./json.js"
import { assertRelationalOperation, type RelationalOperation } from "./operation.js"
import { assertRelationalOrdering, type RelationalOrderBy } from "./ordering.js"
import {
  assertColumnValue,
  assertIdentifier,
  assertRecord,
  defineRelationalSchema,
  requireTable,
  type RelationalColumnDefinition,
  type RelationalSchemaDefinition,
  type RelationalTableDefinition,
} from "./schema.js"
import { relationalOperationTraits, type RelationalOperationTraits } from "./traits.js"

declare module "cordis" {
  interface Context {
    storageRelational: RelationalStorage
  }
}

/** 关系型存储协议的 Cordis 类插件；只负责声明与校验，不执行数据库操作。 */
export class RelationalStorage extends Service {
  constructor(ctx: Context) {
    super(ctx, "storageRelational")
  }

  /**
   * @param schema 逻辑表定义。
   * @returns 校验后的原对象，保留字面量类型。
   */
  defineSchema<const S extends RelationalSchemaDefinition>(schema: S): S {
    return defineRelationalSchema(schema)
  }

  /**
   * @param schema 逻辑 Schema。
   * @param operation 待校验操作。
   * @returns 无返回值。
   */
  assertOperation(schema: RelationalSchemaDefinition, operation: RelationalOperation): void {
    assertRelationalOperation(schema, operation)
  }

  /**
   * @param schema 逻辑 Schema。
   * @param operation 待分析操作。
   * @returns 写入队列所需特征。
   */
  operationTraits(
    schema: RelationalSchemaDefinition,
    operation: RelationalOperation,
  ): RelationalOperationTraits {
    return relationalOperationTraits(schema, operation)
  }

  /**
   * @param schema 逻辑 Schema。
   * @param tableName 表名。
   * @returns 对应表定义。
   */
  requireTable(schema: RelationalSchemaDefinition, tableName: string): RelationalTableDefinition {
    return requireTable(schema, tableName)
  }

  /**
   * @param tableName 表名。
   * @param table 表定义。
   * @param filter 条件树。
   * @returns 无返回值。
   */
  assertFilter(
    tableName: string,
    table: RelationalTableDefinition,
    filter: RelationalFilter,
  ): void {
    assertRelationalFilter(tableName, table, filter)
  }

  /**
   * @param tableName 表名。
   * @param table 表定义。
   * @param ordering 排序项。
   * @returns 无返回值。
   */
  assertOrdering(
    tableName: string,
    table: RelationalTableDefinition,
    ordering: readonly RelationalOrderBy[],
  ): void {
    assertRelationalOrdering(tableName, table, ordering)
  }

  /**
   * @param tableName 表名。
   * @param table 表定义。
   * @param record 行数据。
   * @param mode 插入或更新。
   * @returns 无返回值。
   */
  assertRecord(
    tableName: string,
    table: RelationalTableDefinition,
    record: RelationalRecord,
    mode: "insert" | "patch",
  ): void {
    assertRecord(tableName, table, record, mode)
  }

  /**
   * @param tableName 表名。
   * @param field 字段名。
   * @param column 字段定义。
   * @param value 待校验值。
   * @returns 无返回值。
   */
  assertColumnValue(
    tableName: string,
    field: string,
    column: RelationalColumnDefinition,
    value: unknown,
  ): asserts value is JsonValue {
    assertColumnValue(tableName, field, column, value)
  }

  /**
   * @param value 标识符。
   * @param label 标识符类别。
   * @returns 无返回值。
   */
  assertIdentifier(value: string, label: string): void {
    assertIdentifier(value, label)
  }

  /**
   * @param value 未知数据。
   * @returns 是否可按 JSON 语义处理。
   */
  isJsonValue(value: unknown): value is JsonValue {
    return isJsonValue(value)
  }
}

export default RelationalStorage

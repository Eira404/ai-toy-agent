import { RelationalError } from "./error.js"
import { assertRelationalFilter, type RelationalFilter } from "./filter.js"
import type { JsonPrimitive, RelationalRecord } from "./json.js"
import { assertRelationalOrdering, type RelationalOrderBy } from "./ordering.js"
import {
  assertColumnValue,
  assertRecord,
  requireTable,
  type RelationalSchemaDefinition,
} from "./schema.js"

/** 可以作为逻辑主键的通用值；第一版只接受字符串和数字。 */
export type RelationalKey = Exclude<JsonPrimitive, boolean | null>

/** 按主键精确读取一行。 */
export interface GetOperation {
  readonly type: "get"
  readonly table: string
  readonly key: RelationalKey
}

/** 按条件、排序和分页读取多行。 */
export interface FindOperation {
  readonly type: "find"
  readonly table: string
  readonly where?: RelationalFilter
  readonly orderBy?: readonly RelationalOrderBy[]
  readonly limit?: number
  readonly offset?: number
}

/** 统计满足可选条件的行数。 */
export interface CountOperation {
  readonly type: "count"
  readonly table: string
  readonly where?: RelationalFilter
}

/** 插入一行；主键冲突时 adapter 应抛出 duplicate-key。 */
export interface InsertOperation {
  readonly type: "insert"
  readonly table: string
  readonly value: RelationalRecord
}

/** 按输入顺序插入多行。 */
export interface InsertManyOperation {
  readonly type: "insertMany"
  readonly table: string
  readonly values: readonly RelationalRecord[]
}

/** 按主键插入或替换一行。 */
export interface UpsertOperation {
  readonly type: "upsert"
  readonly table: string
  readonly value: RelationalRecord
}

/** 修改满足条件的记录；不允许通过 patch 修改主键。 */
export interface UpdateOperation {
  readonly type: "update"
  readonly table: string
  readonly where: RelationalFilter
  readonly patch: RelationalRecord
}

/** 删除满足条件的记录。 */
export interface DeleteOperation {
  readonly type: "delete"
  readonly table: string
  readonly where: RelationalFilter
}

/** 第一版所有可移植关系型操作的判别联合。 */
export type RelationalOperation =
  | GetOperation
  | FindOperation
  | CountOperation
  | InsertOperation
  | InsertManyOperation
  | UpsertOperation
  | UpdateOperation
  | DeleteOperation

/** 上层路由服务接收的命名数据源请求。adapter 只接收其中的 operation。 */
export interface RelationalRequest<O extends RelationalOperation = RelationalOperation> {
  readonly source: string
  readonly operation: O
}

/**
 * 在进入内存实现或数据库 adapter 前校验完整操作。
 *
 * @param schema 操作必须遵守的逻辑 Schema。
 * @param operation 待校验的关系型操作。
 * @returns 校验成功时无返回值。
 * @throws {RelationalError} 表、字段、值、条件或分页不合法时抛出。
 */
export function assertRelationalOperation(
  schema: RelationalSchemaDefinition,
  operation: RelationalOperation,
): void {
  // 先取得表定义，后续所有字段和值校验都以同一份 Schema 为准。
  const table = requireTable(schema, operation.table)

  // 判别字段决定每种操作需要验证的独有不变量。
  switch (operation.type) {
    case "get": {
      const primary = table.columns[table.primaryKey]
      if (primary === undefined) {
        throw new RelationalError("invalid-schema", `表 '${operation.table}' 缺少主键定义`)
      }
      assertColumnValue(operation.table, table.primaryKey, primary, operation.key)
      return
    }
    case "find":
      if (operation.where !== undefined) {
        assertRelationalFilter(operation.table, table, operation.where)
      }
      if (operation.orderBy !== undefined) {
        assertRelationalOrdering(operation.table, table, operation.orderBy)
      }
      assertPagination(operation.limit, operation.offset)
      return
    case "count":
      if (operation.where !== undefined) {
        assertRelationalFilter(operation.table, table, operation.where)
      }
      return
    case "insert":
    case "upsert":
      assertRecord(operation.table, table, operation.value, "insert")
      return
    case "insertMany":
      if (operation.values.length === 0) {
        throw new RelationalError("invalid-operation", "insertMany 至少需要一条记录")
      }
      for (const value of operation.values) {
        // 批量写入的每一行都必须独立满足主键和字段类型约束。
        assertRecord(operation.table, table, value, "insert")
      }
      return
    case "update":
      // 先验证 where，避免非法条件进入 adapter 后退化为意外全表更新。
      assertRelationalFilter(operation.table, table, operation.where)
      if (Object.keys(operation.patch).length === 0) {
        throw new RelationalError("invalid-operation", "update 的 patch 不能为空")
      }
      assertRecord(operation.table, table, operation.patch, "patch")
      return
    case "delete":
      assertRelationalFilter(operation.table, table, operation.where)
  }
}

/**
 * 校验 find 使用的 limit 和 offset。
 *
 * @param limit 最大返回行数；省略表示不由协议限制。
 * @param offset 跳过的行数；省略等价于零。
 * @returns 分页参数合法时无返回值。
 * @throws {RelationalError} 数值不是安全整数或超出允许范围时抛出。
 */
function assertPagination(limit: number | undefined, offset: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new RelationalError("invalid-operation", "find.limit 必须是正安全整数")
  }
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
    throw new RelationalError("invalid-operation", "find.offset 必须是非负安全整数")
  }
}

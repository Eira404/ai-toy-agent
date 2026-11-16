import type {
  CountOperation,
  DeleteOperation,
  FindOperation,
  GetOperation,
  InsertManyOperation,
  InsertOperation,
  RelationalOperation,
  UpdateOperation,
  UpsertOperation,
} from "./operation.js"
import type { RelationalRecord } from "./json.js"

/** get 返回的单行结果；undefined 表示主键不存在。 */
export interface GetResult {
  readonly row: RelationalRecord | undefined
}

/** find 返回的有序行集合。 */
export interface FindResult {
  readonly rows: readonly RelationalRecord[]
}

/** count 返回的非负行数。 */
export interface CountResult {
  readonly count: number
}

/** insert 提交后返回的完整行，包括 adapter 生成的字段。 */
export interface InsertResult {
  readonly row: RelationalRecord
}

/** insertMany 按输入顺序返回的完整行。 */
export interface InsertManyResult {
  readonly rows: readonly RelationalRecord[]
}

/** upsert 返回最终行以及本次是否执行了插入。 */
export interface UpsertResult {
  readonly row: RelationalRecord
  readonly inserted: boolean
}

/** update 实际修改的行数。 */
export interface UpdateResult {
  readonly affectedRows: number
}

/** delete 实际删除的行数。 */
export interface DeleteResult {
  readonly affectedRows: number
}

/** 所有关系型操作结果的联合类型。 */
export type RelationalResult =
  | GetResult
  | FindResult
  | CountResult
  | InsertResult
  | InsertManyResult
  | UpsertResult
  | UpdateResult
  | DeleteResult

/** 根据单个操作判别字段推导其精确返回类型。 */
export type RelationalResultOf<O extends RelationalOperation> = O extends GetOperation
  ? GetResult
  : O extends FindOperation
    ? FindResult
    : O extends CountOperation
      ? CountResult
      : O extends InsertOperation
        ? InsertResult
        : O extends InsertManyOperation
          ? InsertManyResult
          : O extends UpsertOperation
            ? UpsertResult
            : O extends UpdateOperation
              ? UpdateResult
              : O extends DeleteOperation
                ? DeleteResult
                : never

/** 将操作元组逐项映射为顺序一致的结果元组。 */
export type RelationalResultsOf<Operations extends readonly RelationalOperation[]> = {
  readonly [Index in keyof Operations]: Operations[Index] extends RelationalOperation
    ? RelationalResultOf<Operations[Index]>
    : never
}

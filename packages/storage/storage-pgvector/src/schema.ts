import type { PoolClient } from "pg"
import { VectorError, type VectorSchemaDefinition } from "toy-storage-vector"
import { FILTER_COLUMN_TYPES, qualifiedName, quoteIdentifier } from "./sql.js"

/** 已启用的扩展对象位置，用于限定向量类型和距离运算符。 */
export interface VectorExtension {
  readonly schema: string
  readonly typeId: string
}

interface ColumnInfo {
  readonly name: string
  readonly type: string
  readonly typeSchema: string
  readonly typeId: string
  readonly modifier: number
  readonly required: boolean
  readonly primaryKey: boolean
}

/** 从目标数据库发现 vector 的安装位置和类型 OID。 */
export async function requireVectorExtension(client: PoolClient): Promise<VectorExtension> {
  const { rows } = await client.query<VectorExtension>(
    `SELECT n.nspname AS "schema", t.oid::text AS "typeId"
       FROM pg_catalog.pg_extension AS e
       JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace
       JOIN pg_catalog.pg_type AS t ON t.typnamespace = n.oid AND t.typname = 'vector'
      WHERE e.extname = 'vector'`,
  )
  const extension = rows[0]
  if (extension === undefined) {
    throw new VectorError("invalid-schema", "当前数据库需要先通过迁移启用 vector 扩展")
  }
  return extension
}

/** 拒绝会被截断的物理名称与超出 pgvector 类型范围的维度。 */
export function assertPhysicalSchema(schemaName: string, schema: VectorSchemaDefinition): void {
  quoteIdentifier(schemaName)
  for (const [name, collection] of Object.entries(schema.collections)) {
    quoteIdentifier(name)
    if (collection.dimensions > 16_000) {
      throw new VectorError("invalid-schema", `集合 '${name}' 的 vector 最多支持 16000 维`)
    }
    for (const field of Object.keys(collection.filterFields ?? {})) {
      quoteIdentifier(field)
    }
  }
}

/**
 * 可选地创建缺失表，然后逐表验证物理约束。结构不兼容时，由外层事务撤销本次 DDL。
 *
 * @param client 本次初始化独占的事务连接。
 * @param schemaName 集合表所在的 PostgreSQL schema。
 * @param schema 已通过基础包校验的逻辑集合。
 * @param extension vector 的安装位置与类型信息。
 * @param createMissing 是否允许创建缺失的 schema 和表。
 */
export async function initializeCollections(
  client: PoolClient,
  schemaName: string,
  schema: VectorSchemaDefinition,
  extension: VectorExtension,
  createMissing: boolean,
): Promise<void> {
  if (createMissing) {
    // CREATE IF NOT EXISTS 本身不足以防止并发创建时的目录冲突。
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      [`toy-storage-pgvector:${schemaName}`],
    )
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`)
  }
  const vectorType = qualifiedName(extension.schema, "vector")
  for (const [name, collection] of Object.entries(schema.collections)) {
    const fields = Object.entries(collection.filterFields ?? {})
    if (createMissing) {
      const columns = [
        `${quoteIdentifier("id")} pg_catalog.text COLLATE pg_catalog.${quoteIdentifier("C")} PRIMARY KEY`,
        `"embedding" ${vectorType}(${collection.dimensions}) NOT NULL`,
        `${quoteIdentifier("payload")} pg_catalog.jsonb`,
        ...fields.map(([field, type]) => {
          const collation = type === "string" ? ` COLLATE pg_catalog.${quoteIdentifier("C")}` : ""
          return `${quoteIdentifier(field)} pg_catalog.${FILTER_COLUMN_TYPES[type]}${collation} NOT NULL`
        }),
      ]
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${qualifiedName(schemaName, name)} (${columns.join(", ")})`,
      )
    }

    const columns = await readColumns(client, schemaName, name)
    if (columns.size === 0) {
      throw new VectorError("collection-not-found", `向量集合表 '${schemaName}.${name}' 不存在`)
    }
    assertBuiltinColumn(columns, name, "id", "text", true)
    assertBuiltinColumn(columns, name, "payload", "jsonb", false)
    if (!columns.get("id")?.primaryKey) {
      throw new VectorError("invalid-schema", `集合 '${name}' 需要以 id 为独立的非延迟主键`)
    }
    const embedding = columns.get("embedding")
    if (
      embedding?.typeId !== extension.typeId ||
      embedding.modifier !== collection.dimensions ||
      !embedding.required
    ) {
      throw new VectorError(
        "invalid-schema",
        `集合 '${name}' 的 embedding 必须是 vector(${collection.dimensions}) NOT NULL`,
      )
    }
    for (const [field, type] of fields) {
      assertBuiltinColumn(columns, name, field, FILTER_COLUMN_TYPES[type], true)
    }
  }
}

/** pgvector 将固定维度直接存入 embedding 列的 atttypmod。 */
async function readColumns(
  client: PoolClient,
  schemaName: string,
  table: string,
): Promise<Map<string, ColumnInfo>> {
  const { rows } = await client.query<ColumnInfo>(
    `SELECT a.attname AS name, t.typname AS type, tn.nspname AS "typeSchema",
            a.atttypid::text AS "typeId", a.atttypmod AS modifier, a.attnotnull AS required,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_constraint AS pk
               WHERE pk.conrelid = c.oid AND pk.contype = 'p' AND NOT pk.condeferrable
                 AND pk.conkey = ARRAY[a.attnum]
            ) AS "primaryKey"
       FROM pg_catalog.pg_class AS c
       JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid
       JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
       JOIN pg_catalog.pg_namespace AS tn ON tn.oid = t.typnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [schemaName, table],
  )
  return new Map(rows.map((column) => [column.name, column]))
}

function assertBuiltinColumn(
  columns: ReadonlyMap<string, ColumnInfo>,
  table: string,
  field: string,
  type: string,
  required: boolean,
): void {
  const column = columns.get(field)
  if (column?.typeSchema !== "pg_catalog" || column.type !== type || column.required !== required) {
    throw new VectorError(
      "invalid-schema",
      `集合 '${table}' 的 '${field}' 必须是 ${type} ${required ? "NOT NULL" : "且允许 NULL"}`,
    )
  }
}

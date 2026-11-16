/* global console, process */
import { Pool } from "pg"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("缺少 DATABASE_URL；请在仓库根目录的 .env 中配置")
}

const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
try {
  // 数据库返回身份与会话信息，证明已建立真实连接并执行了查询。
  const identity = await pool.query(`
    SELECT current_database() AS database,
           current_user AS username,
           current_setting('server_version') AS version,
           pg_backend_pid() AS backend_pid,
           current_setting('log_statement') AS log_statement
  `)
  console.log("连接成功：", identity.rows[0])

  // 示例表是上一条示例命令写入的；没有运行示例时，仍可完成连接验证。
  const table = await pool.query("SELECT to_regclass('toy_storage_example.events') AS name")
  if (table.rows[0]?.name) {
    const count = await pool.query("SELECT COUNT(*)::int AS count FROM toy_storage_example.events")
    const rows = await pool.query(`
      SELECT "eventId", "sessionId", sequence, content
      FROM toy_storage_example.events
      LIMIT 5
    `)
    console.log("示例表记录数：", count.rows[0].count)
    console.log("示例记录：", rows.rows)
  } else {
    console.log("示例表尚未创建；运行 npm run example -w toy-storage-postgres 后再检查")
  }
} finally {
  await pool.end()
}

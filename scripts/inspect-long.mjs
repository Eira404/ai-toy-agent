import pg from "pg"

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const b = await c.query(
  "SELECT block_id, title, char_length(summary) AS slen, char_length(overview_body) AS blen FROM toy_memory_long_blocks ORDER BY created_at DESC LIMIT 8",
)
const d = await c.query("SELECT count(*)::int AS n FROM toy_memory_long_details")
console.log("blocks:")
for (const r of b.rows) {
  console.log("  ", r.title, "| summary", r.slen, "chars | overview", r.blen, "chars")
}
console.log("details total:", d.rows[0].n)
await c.end()

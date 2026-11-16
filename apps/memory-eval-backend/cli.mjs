/**
 * 命令行入口：加载 `.env` → 创建 adapter → runEval + conclusion。
 *
 * 用法（apps/memory-eval-backend 目录下，自动读取本目录 .env）：
 *   node cli.mjs --adapter internal --limit 3 --out runs/smoke
 *   node cli.mjs --adapter longmemeval_v1 --data data/longmemeval_oracle.json --limit 2 --out runs/smoke-lm
 */
import "./env.mjs"
import { createAdapter } from "./adapter-factory.mjs"
import { runOnce } from "./run-once.mjs"

const args = parseArgs(process.argv.slice(2))

if (args.help || args.adapter === undefined) {
  console.log(
    "用法：cli.mjs --adapter <internal|longmemeval_v1> [--data <file>] [--start N] [--limit N] [--out <dir>] [--concurrency N] [--csv]",
  )
  process.exit(args.help ? 0 : 1)
}

let adapter
try {
  adapter = createAdapter(args)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

await adapter.load()

const outDir = args.out ?? `runs/${adapter.id}-${Date.now()}`
const { conclusion } = await runOnce(adapter, {
  outDir,
  concurrency: args.concurrency ?? 10,
  csv: args.csv === true,
})

console.log("\n=== 评测完成 ===")
console.log(
  `总体准确率：${(conclusion.stats.overall.accuracy * 100).toFixed(2)}%（${conclusion.stats.overall.correct}/${conclusion.stats.overall.total}）`,
)
for (const g of conclusion.stats.groups) {
  console.log(`  ${g.group}: ${(g.accuracy * 100).toFixed(2)}%（${g.correct}/${g.total}）`)
}
console.log(`结论：${conclusion.conclusionFile}`)
console.log(`原始记录：${conclusion.recordsFile}${conclusion.csvFile ? ` · ${conclusion.csvFile}` : ""}`)

/** 极简参数解析：支持 --key value 与 --flag。 */
function parseArgs(tokens) {
  const out = {}
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === "--csv" || token === "--help") {
      out[token.slice(2)] = true
      continue
    }
    if (token.startsWith("--")) {
      const key = token.slice(2)
      const next = tokens[i + 1]
      if (next === undefined || next.startsWith("--")) {
        out[key] = true
      } else {
        const num = Number(next)
        out[key] =
          next !== "" && Number.isFinite(num) && !next.startsWith("0x") && /^-?\d+$/.test(next)
            ? num
            : next
        i += 1
      }
    }
  }
  return out
}

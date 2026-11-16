/**
 * 加载本目录下的 `.env`（不存在则跳过，不覆盖已存在的环境变量）。
 *
 * 通过 `import "./env.mjs"` 引入即可，cli 与 serve 共用。
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const envFile = join(__dirname, ".env")

if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile)
  } catch (error) {
    console.warn(`[env] 加载 ${envFile} 失败：`, error?.message ?? error)
  }
}

/**
 * 一次完整评测：runEval → runConclusion → 释放 Cordis 资源（cli 与 serve 共用）。
 */
import { runEval } from "./runner.mjs"
import { runConclusion } from "./conclusion.mjs"

/** 默认模型路由（与 runner.mount 保持一致）。 */
export function defaultLlmCfg() {
  return { provider: "dashscope", model: process.env.LLM_MODEL ?? "qwen3.7-max" }
}

/**
 * @param {import("./adapters/types.ts").BenchmarkAdapter} adapter 已 load 的 adapter。
 * @param {{ outDir: string, concurrency?: number, csv?: boolean }} options
 */
export async function runOnce(adapter, { outDir, concurrency = 10, csv = false }) {
  const llmCfg = defaultLlmCfg()
  const result = await runEval({ adapter, outDir, concurrency })
  try {
    const conclusion = await runConclusion({
      ctx: result.ctx,
      llmCfg,
      run: result.run,
      resultsFile: result.files.resultsFile,
      outDir,
      csv,
    })
    return { run: result.run, conclusion }
  } finally {
    for (const fiber of result.fibers.reverse()) {
      await fiber.dispose()
    }
  }
}

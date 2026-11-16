/**
 * 评测 runner：建空间 → extract（串行）→ daily → query/answer/judge（并发）。
 *
 * 装配复用 `benchmarks/longmemeval/run.mjs` 的 Cordis 拓扑，schema 固定 `memory_eval`
 * （隔离生产 `public`），JEV 视环境变量有无可选挂载。
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { VectorStorage } from "toy-storage-vector"
import { PostgresStorage } from "toy-storage-postgres"
import { PgvectorStorage } from "toy-storage-pgvector"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"
import { MemorySpaceService, spaceRelationalSchema } from "toy-memory-space"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { LongMemory, longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"
import { MemoryFeedback, feedbackRelationalSchema } from "toy-memory-feedback"
import { ParallelExecutor } from "toy-parallel-executor"
import { FastWrite } from "toy-memory-write"
import { MemoryRead } from "toy-memory-read"
import { MemoryDaily, dailyRelationalSchema } from "toy-memory-daily"

import { appendLine, writeRun, readRun, hashConfig, nowIso } from "./store.mjs"
import { extractKey, loadExtractDone, loadJudgedQuestionIds } from "./resume.mjs"
import { answerQuestion, judgeAnswer, sumUsage } from "./llm.mjs"

const DIMENSIONS = 1024
const SCHEMA = "memory_eval"

/** 装配 Cordis 上下文，返回 ctx + 各插件 fiber（反向 dispose）+ 模型路由。 */
export async function mount(env = process.env) {
  const llmModel = env.LLM_MODEL ?? "qwen3.7-max"
  const embeddingModel = env.EMBEDDING_MODEL ?? "qwen3.7-text-embedding-flash"
  const jevModel = env.JEV_MODEL ?? ""
  const useJev = jevModel.trim().length > 0

  if (!env.DATABASE_URL) {
    throw new Error("缺少 DATABASE_URL（PostgreSQL 连接串）")
  }
  if (!env.DASHSCOPE_RESPONSES_BASE_URL) {
    throw new Error("缺少 DASHSCOPE_RESPONSES_BASE_URL（Responses API 地址）")
  }

  const mergedRelationalSchema = {
    tables: {
      ...spaceRelationalSchema.tables,
      ...fastRelationalSchema.tables,
      ...longRelationalSchema.tables,
      ...feedbackRelationalSchema.tables,
      ...dailyRelationalSchema.tables,
    },
  }
  const mergedVectorSchema = {
    collections: {
      ...defineFastVectorSchema(DIMENSIONS).collections,
      ...defineLongVectorSchema(DIMENSIONS).collections,
    },
  }

  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(VectorStorage))
  fibers.push(
    await ctx.plugin(PostgresStorage, {
      name: "main",
      connectionString: env.DATABASE_URL,
      createMissing: true,
      schemaName: SCHEMA,
      schema: mergedRelationalSchema,
    }),
  )
  fibers.push(
    await ctx.plugin(PgvectorStorage, {
      name: "main",
      connectionString: env.DATABASE_URL,
      createMissing: true,
      schemaName: SCHEMA,
      schema: mergedVectorSchema,
    }),
  )
  fibers.push(await ctx.plugin(EmbeddingRuntime))
  fibers.push(
    await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
      provider: "dashscope",
      baseURL: env.DASHSCOPE_EMBEDDING_BASE_URL,
      apiKey: env.DASHSCOPE_API_KEY,
      dimensions: DIMENSIONS,
      timeoutMs: 30_000,
    }),
  )
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(
    await ctx.plugin(OpenAIResponsesPlugin, {
      provider: "dashscope",
      baseURL: env.DASHSCOPE_RESPONSES_BASE_URL,
      apiKey: env.DASHSCOPE_API_KEY,
    }),
  )
  fibers.push(await ctx.plugin(JevRuntime))
  if (useJev) {
    fibers.push(
      await ctx.plugin(JevTypesafePlugin, {
        provider: "typesafe",
        baseURL: env.JEV_BASE_URL,
        apiKey: env.JEV_API_KEY,
        model: jevModel,
      }),
    )
    // daily 的 assign/verify 以「链名」调用 JEV，链内绑定 adapter + model。
    ctx.jev.registerChain("jev-main", [{ provider: "typesafe", model: jevModel }])
  }
  fibers.push(await ctx.plugin(MemorySpaceService))
  fibers.push(
    await ctx.plugin(FastMemory, { embeddingProvider: "dashscope", embeddingModel, autoIndex: false }),
  )
  fibers.push(await ctx.plugin(LongMemory))
  fibers.push(await ctx.plugin(MemoryFeedback))
  fibers.push(await ctx.plugin(FastWrite, { llmProvider: "dashscope", llmModel: llmModel }))
  fibers.push(await ctx.plugin(MemoryRead, { embeddingProvider: "dashscope", embeddingModel }))
  fibers.push(await ctx.plugin(ParallelExecutor))
  fibers.push(
    await ctx.plugin(MemoryDaily, {
      llmProvider: "dashscope",
      llmModel: llmModel,
      ...(useJev ? { jevProvider: "jev-main" } : {}),
      embeddingProvider: "dashscope",
      embeddingModel,
    }),
  )
  return { ctx, fibers, llmCfg: { provider: "dashscope", model: llmModel } }
}

/**
 * 运行一次评测：建空间 → extract → daily → query/answer/judge，边跑边写 JSONL 进度。
 *
 * @param {object} options
 * @param {import("../adapters/types.ts").BenchmarkAdapter} options.adapter
 * @param {string} options.outDir 运行目录（含 run.json / extract_progress.jsonl / results.jsonl）。
 * @param {number} [options.concurrency] 题间并发（默认 10）。
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function runEval({ adapter, outDir, concurrency = 10, env = process.env }) {
  mkdirSync(outDir, { recursive: true })
  const runFile = join(outDir, "run.json")
  const extractFile = join(outDir, "extract_progress.jsonl")
  const resultsFile = join(outDir, "results.jsonl")

  const { ctx, fibers, llmCfg } = await mount(env)

  try {
    const normalized = adapter.normalize()
    const mode = normalized.mode
    const userId = adapter.id // user 按测试集名字命名
    const configHash = hashConfig(
      adapter.id,
      mode,
      SCHEMA,
      llmCfg.provider,
      llmCfg.model,
      concurrency,
    )

    // run.json：已存在则续跑（沿用其 runId / counters），否则新建。
    let run = readRun(runFile)
    if (run === null) {
      run = {
        runId: `run-${Date.now()}`,
        adapterId: adapter.id,
        configHash,
        mode,
        schema: SCHEMA,
        status: "running",
        counters: { extractDone: 0, extractTotal: 0, judged: 0, judgedTotal: normalized.questions.length },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
    }
    const runId = run.runId

    // 已完成：直接返回，避免重跑 daily 浪费 token（结论由 cli 重新生成）。
    if (run.status === "done") {
      console.log(`run ${runId} 已完成，跳过 pipeline（结论将在 cli 中重新生成）`)
      return { ctx, fibers, run, files: { runFile, extractFile, resultsFile } }
    }

    const extractDone = loadExtractDone(extractFile, runId)
    const judgedIds = loadJudgedQuestionIds(resultsFile, runId)

    // ---- 建空间：每题一个独立空间，命名 <数据集>-<测试时间>-<测试题号> ----
    // 玩偶与空间同名（resolveOrCreateMemorySpace 用 deviceId 作为空间名并绑定该 device），
    // user = 测试集名字。不同题目的记忆彼此隔离，避免串题。
    const testTime = runId // 测试时间：runId（唯一、含时间戳、resume 时稳定不变）
    const spaceUnits = []
    const questionToScope = new Map()
    for (const item of normalized.items) {
      if (item.questionId === undefined) {
        throw new Error("eval 要求每题独立空间：adapter 的每个 item 都必须带 questionId")
      }
      const deviceId = `${adapter.id}-${testTime}-${item.questionId}`
      const { memorySpaceId } = await ctx.memorySpace.resolveOrCreateMemorySpace(userId, deviceId)
      const scope = { userId, memorySpaceId }
      spaceUnits.push({ item, spaceKey: deviceId, scope, turns: adapter.buildTurns(item) })
      questionToScope.set(item.questionId, scope)
    }

    run.counters.extractTotal = spaceUnits.reduce((sum, unit) => sum + unit.turns.length, 0)
    await writeRun(runFile, run)

    // ---- 阶段一：extract（每空间串行）+ daily ----
    for (const unit of spaceUnits) {
      for (const turn of unit.turns) {
        const key = extractKey(unit.spaceKey, turn.sessionId, turn.turnId)
        if (extractDone.has(key)) {
          continue
        }
        const result = await ctx.memoryWrite.extract(
          {
            scope: unit.scope,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            userMessage: turn.userMessage,
            recentConversation: turn.recentConversation,
          },
          "written",
        )
        const status = result.kind === "failed" ? "error" : "done"
        await appendLine(extractFile, {
          runId,
          spaceKey: unit.spaceKey,
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          status,
          writeId: result.kind === "written" ? result.writeId : null,
          tokens: null,
          error: result.kind === "failed" ? result.error : null,
          ts: nowIso(),
        })
        if (status === "done") {
          run.counters.extractDone += 1
        }
        run.updatedAt = nowIso()
        await writeRun(runFile, run)
        console.log(`[extract] ${unit.spaceKey} ${turn.turnId} → ${result.kind}`)
      }

      // daily：崩溃重跑一次（不做阶段级 resume，§6）。
      console.log(`[daily] ${unit.spaceKey} 开始`)
      let dailyOk = false
      let dailyError = null
      for (let attempt = 1; attempt <= 2 && !dailyOk; attempt += 1) {
        try {
          await ctx.memoryDaily.runDaily(unit.scope)
          dailyOk = true
        } catch (error) {
          dailyError = error
          console.error(`[daily] ${unit.spaceKey} 第 ${attempt} 次失败：`, error?.message ?? error)
        }
      }
      if (dailyOk) {
        console.log(`[daily] ${unit.spaceKey} 完成`)
      } else {
        console.error(`[daily] ${unit.spaceKey} 重跑后仍失败，跳过（记 partial）`)
        run.dailyError = String(dailyError?.message ?? dailyError)
        run.updatedAt = nowIso()
        await writeRun(runFile, run)
      }
    }

    // ---- 阶段二：query/answer/judge（题间并发 concurrency） ----
    const pendingQuestions = normalized.questions.filter((q) => !judgedIds.has(q.questionId))
    let judged = judgedIds.size
    let judgeError = false

    await mapConcurrent(pendingQuestions, concurrency, async (q) => {
      const scope = questionToScope.get(q.questionId)
      try {
        const search = await ctx.memoryRead.search({ scope, query: q.text, mode: "strong" })
        const retrieved = summarizeSearch(search)
        const { predicted, usage: answerUsage } = await answerQuestion(
          ctx,
          llmCfg,
          q.text,
          retrievedToText(retrieved),
        )
        const judgePrompt = adapter.judge(q, predicted, q.gold)
        const { judge, usage: judgeUsage } = await judgeAnswer(ctx, llmCfg, judgePrompt)
        await appendLine(resultsFile, {
          runId,
          questionId: q.questionId,
          type: q.type,
          question: q.text,
          gold: q.gold,
          predicted,
          judge,
          retrieved,
          tokens: sumUsage(answerUsage, judgeUsage),
          ts: nowIso(),
        })
        judged += 1
        run.counters.judged = judged
        run.updatedAt = nowIso()
        await writeRun(runFile, run)
        console.log(`[judge] ${q.questionId} → ${judge.correct ? "correct" : "wrong"}`)
      } catch (error) {
        judgeError = true
        console.error(`[judge] ${q.questionId} 失败，重跑时重试：`, error)
      }
    })

    run.status = judgeError ? "partial" : "done"
    run.updatedAt = nowIso()
    await writeRun(runFile, run)

    return { ctx, fibers, run, files: { runFile, extractFile, resultsFile } }
  } catch (error) {
    for (const fiber of fibers.reverse()) {
      await fiber.dispose()
    }
    throw error
  }
}

/** 并发映射：最多 `limit` 个并发，保持输入顺序。 */
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) {
        return
      }
      results[i] = await fn(items[i], i)
    }
  }
  const count = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: count }, () => worker()))
  return results
}

/** 汇总检索结果为结构化摘要（供结果落盘）。 */
function summarizeSearch(result) {
  return {
    status: result.status,
    fast: result.fast.hits.map((hit) => ({
      title: hit.record.title,
      summary: hit.record.summary,
      body: hit.record.body,
      matchedBy: hit.matchedBy,
    })),
    long: result.long.blocks.map((block) => ({
      title: block.title,
      aliases: block.aliases,
      summary: block.summary,
      overviewBody: block.overviewBody,
      reason: block.reason,
      details: block.details.map((d) => ({ summary: d.summary, body: d.body })),
    })),
  }
}

/** 把检索摘要拼成 answer LLM 的记忆正文。 */
function retrievedToText(retrieved) {
  const parts = []
  for (const fast of retrieved.fast) {
    parts.push(`- [Fast] ${fast.title}: ${fast.body}`)
  }
  for (const block of retrieved.long) {
    parts.push(`- [Long] ${block.title}: ${block.overviewBody}`)
    for (const detail of block.details) {
      parts.push(`  - ${detail.summary}: ${detail.body}`)
    }
  }
  return parts.length > 0 ? parts.join("\n") : "(no retrieved memory)"
}

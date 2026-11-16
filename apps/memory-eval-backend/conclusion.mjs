/**
 * 结论报告（完成/中断）+ 原始记录导出（对齐 REQUIREMENTS.md §8）。
 *
 * - 总体准确率 + 分能力表：确定性统计。
 * - 错题聚类 + 优缺点 + 优化建议：LLM 生成。
 * - 原始记录：records.jsonl（每题全字段）+ 可选 CSV。
 */
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readLines, appendLine, nowIso } from "./store.mjs"
import { extractText } from "./llm.mjs"

const CONCLUSION_SYSTEM =
  "你是记忆系统评测分析师。根据给出的错误题列表，分析记忆系统（extract→Fast→daily→Long）的问题。" +
  "输出 markdown：先按「能力 + 错误类型」聚类错题（错误类型限定为：检索 miss / 生成错 / 幻觉 / 更新 miss / 时间 miss），" +
  "再给出系统优缺点与优化建议。语言与题目一致，简洁、可执行。"

/**
 * 运行结论：读 results.jsonl → 统计 + LLM 结论 + records.jsonl + 可选 CSV。
 *
 * @param {object} options
 * @param {{ llm: { generate: Function } }} options.ctx
 * @param {{ provider: string, model: string }} options.llmCfg
 * @param {object} options.run run.json 内容。
 * @param {string} options.resultsFile results.jsonl 路径。
 * @param {string} options.outDir 运行目录。
 * @param {boolean} [options.csv] 是否导出 CSV。
 */
export async function runConclusion({ ctx, llmCfg, run, resultsFile, outDir, csv = false }) {
  const all = readLines(resultsFile).filter((line) => line && line.runId === run.runId)
  const stats = computeStats(all)

  // 原始记录：results 即「每题全字段」，落一份 records.jsonl。
  const recordsFile = join(outDir, "records.jsonl")
  for (const line of all) {
    await appendLine(recordsFile, line)
  }

  let csvFile = null
  if (csv) {
    csvFile = join(outDir, "records.csv")
    await writeCsv(csvFile, all)
  }

  const partial = run.status !== "done"
  const conclusion = await generateConclusion(ctx, llmCfg, { stats, wrong: all.filter((l) => !l.judge?.correct), partial })
  const conclusionFile = join(outDir, "conclusion.md")

  const lines = [
    "# 记忆系统评测结论",
    "",
    `- 运行 ID：\`${run.runId}\``,
    `- adapter：\`${run.adapterId}\`（mode=${run.mode}）`,
    `- 状态：${partial ? `部分结论（${stats.overall.correct}/${run.counters?.judgedTotal ?? stats.overall.total}）` : "完成"}`,
    `- **总体准确率：${(stats.overall.accuracy * 100).toFixed(2)}%**（${stats.overall.correct}/${stats.overall.total}）`,
    "",
    "## 分能力得分",
    "",
    "| 能力 | 正确 | 总数 | 准确率 |",
    "| --- | --- | --- | --- |",
    ...stats.groups.map(
      (g) => `| ${g.group} | ${g.correct} | ${g.total} | ${(g.accuracy * 100).toFixed(2)}% |`,
    ),
    "",
    "## 错题分析与结论",
    "",
    conclusion,
    "",
    "## 原始记录",
    "",
    `- [records.jsonl](${recordsFile})`,
    ...(csvFile ? [`- [records.csv](${csvFile})`] : []),
    "",
  ]
  await writeFile(conclusionFile, lines.join("\n"), "utf8")

  return { conclusionFile, recordsFile, csvFile, stats }
}

/** 确定性统计：总体 + 分能力。 */
export function computeStats(results) {
  const total = results.length
  const correct = results.filter((l) => l.judge?.correct === true).length
  const byGroup = new Map()
  for (const line of results) {
    const group = line.type ?? "unknown"
    const bucket = byGroup.get(group) ?? { correct: 0, total: 0 }
    bucket.total += 1
    if (line.judge?.correct === true) {
      bucket.correct += 1
    }
    byGroup.set(group, bucket)
  }
  const groups = [...byGroup.entries()]
    .map(([group, bucket]) => ({
      group,
      correct: bucket.correct,
      total: bucket.total,
      accuracy: bucket.total === 0 ? 0 : bucket.correct / bucket.total,
    }))
    .sort((a, b) => a.group.localeCompare(b.group))
  return {
    overall: { correct, total, accuracy: total === 0 ? 0 : correct / total },
    groups,
  }
}

/** 调用 LLM 生成错题聚类 + 优缺点 + 优化建议。 */
async function generateConclusion(ctx, llmCfg, { stats, wrong, partial }) {
  if (wrong.length === 0) {
    return "没有错题，记忆系统在小数据上全对。"
  }
  const wrongLines = wrong.map((line) => {
    const retrieved =
      line.retrieved?.fast?.length + (line.retrieved?.long?.length ?? 0) ?? 0
    return [
      `### ${line.questionId}（能力：${line.type}）`,
      `题目：${line.question}`,
      `标准答案：${line.gold}`,
      `模型回答：${line.predicted}`,
      `判定理由：${line.judge?.reason ?? ""}`,
      `检索命中：${retrieved} 条`,
    ].join("\n")
  })
  const result = await ctx.llm.generate({
    provider: llmCfg.provider,
    model: llmCfg.model,
    temperature: 0,
    messages: [
      { role: "system", content: [{ type: "text", text: CONCLUSION_SYSTEM }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `${partial ? "这是部分完成的结果。\n" : ""}总体准确率 ${(stats.overall.accuracy * 100).toFixed(2)}%` +
              `（${stats.overall.correct}/${stats.overall.total}）。\n\n错误题列表：\n\n${wrongLines.join("\n\n")}`,
          },
        ],
      },
    ],
  })
  return extractText(result) || "（结论生成失败）"
}

/** 写 CSV（每题一行）。 */
async function writeCsv(csvFile, results) {
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    "questionId",
    "type",
    "question",
    "gold",
    "predicted",
    "correct",
    "reason",
    "tokensInput",
    "tokensOutput",
    "fastHits",
    "longHits",
  ]
  const rows = results.map((line) => [
    line.questionId,
    line.type,
    line.question,
    line.gold,
    line.predicted,
    line.judge?.correct === true ? "yes" : "no",
    line.judge?.reason ?? "",
    line.tokens?.inputTokens ?? 0,
    line.tokens?.outputTokens ?? 0,
    line.retrieved?.fast?.length ?? 0,
    line.retrieved?.long?.length ?? 0,
  ])
  const body = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n"
  await writeFile(csvFile, body, "utf8")
}

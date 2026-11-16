import { Service, type Context } from "cordis"
import type { ToolDefinition, ToolJsonValue } from "toy-tools"
import type { ReadMode, ReadSearchResult } from "toy-memory-read"
import type { RecallUnit } from "toy-memory-feedback"
import "toy-memory-read"
import "toy-memory-write"
import "toy-memory-space"

declare module "cordis" {
  interface Context {
    memoryTools: MemoryTools
  }
}

/**
 * 与 `toy-memory-lifecycle` 的 Turn 预处理节点名对齐的契约：`memory_write` 工具的
 * `isAvailable` 读取 `preprocessing.data["memory-gate"].explicit`，explicit 时才注入。
 */
export const MEMORY_GATE_NODE = "memory-gate"

export interface MemoryToolsConfig {
  /** 检索工具名，默认 `memory_read`。 */
  readonly readToolName?: string
  /** 写入工具名，默认 `memory_write`。 */
  readonly writeToolName?: string
}

/** 主模型提供的记忆草稿（结构等价于 `toy-memory-fast` 的 `FastDraft`）。 */
export interface MemoryDraft {
  readonly title: string
  readonly summary: string
  readonly body: string
}

/** 生产方与 feedback 共用同一召回契约，避免各自声明后格式漂移。 */
export type { RecallUnit }

/**
 * 记忆系统本地工具插件：注册 `memory_read` 与 `memory_write` 两个工具。
 *
 * - `memory_read` 常驻：按 scope 调用 `toy-memory-read`，只记录 Long 价值单元；
 * - `memory_write` 按 JEV 门控注入：仅当本轮用户明确要求记住时可用，直接落库主模型
 *   给出的 title/summary/body（不重复走 LLM 提取）。
 */
export class MemoryTools extends Service {
  static inject = ["tools", "memoryRead", "memoryWrite", "memorySpace"]

  constructor(ctx: Context, config: MemoryToolsConfig = {}) {
    super(ctx, "memoryTools")

    ctx.effect(
      () => ctx.tools.register(readTool(ctx, config.readToolName ?? "memory_read")),
      "memoryTools.registerRead",
    )
    ctx.effect(
      () => ctx.tools.register(writeTool(ctx, config.writeToolName ?? "memory_write")),
      "memoryTools.registerWrite",
    )
  }
}

export default MemoryTools

function readTool(ctx: Context, name: string): ToolDefinition {
  return {
    name,
    description:
      "检索当前用户的长期记忆，返回相关的 Fast 证据与 Long 记忆块正文。query 应为专为记忆检索改写的查询句；mode=weak 只召回相关记忆块，mode=strong 做更彻底的平级检索。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "专为记忆检索改写的查询句" },
        mode: { type: "string", enum: ["weak", "strong"] },
      },
      required: ["query"],
    },
    isAvailable: (_scope, payload) => isMemoryAvailable(payload[MEMORY_GATE_NODE]),
    execute: async (args, context) => {
      const { query, mode } = args as { query: string; mode?: ReadMode }
      const memorySpaceId = await ctx.memorySpace.resolveMemorySpace(
        context.userId,
        context.deviceId,
      )
      if (memorySpaceId === null) {
        return { status: "UNAVAILABLE", reason: "no-memory-space" }
      }
      const result = await ctx.memoryRead.search({
        scope: { userId: context.userId, memorySpaceId },
        query,
        mode: mode === "strong" ? "strong" : "weak",
      })
      context.record({ units: collectRecallUnits(result) })
      return formatReadResult(result)
    },
  }
}

function writeTool(ctx: Context, name: string): ToolDefinition {
  return {
    name,
    description:
      "当用户明确要求记住某内容时调用，把内容写入记忆。memories 是零到多条记忆，每条含 title、summary 与 body（body 为 Markdown 无序列表）。",
    parameters: {
      type: "object",
      properties: {
        memories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              body: { type: "string" },
            },
            required: ["title", "summary", "body"],
          },
        },
      },
      required: ["memories"],
    },
    isAvailable: (_scope, payload) =>
      isGateExplicit(payload[MEMORY_GATE_NODE]) && isMemoryAvailable(payload[MEMORY_GATE_NODE]),
    execute: async (args, context) => {
      const { memories } = args as { memories: readonly MemoryDraft[] }
      const memorySpaceId = await ctx.memorySpace.resolveMemorySpace(
        context.userId,
        context.deviceId,
      )
      if (memorySpaceId === null) {
        return { kind: "failed", reason: "no-memory-space" }
      }
      const result = await ctx.memoryWrite.write({
        scope: { userId: context.userId, memorySpaceId },
        sessionId: context.sessionId,
        turnId: context.turnId,
        drafts: memories,
      })
      return { kind: result.kind, count: result.records.length }
    },
  }
}

/** 把 Long 检索结果投影成 feedback 需要的召回单元（Fast 证据层不登记）。 */
export function collectRecallUnits(result: ReadSearchResult): RecallUnit[] {
  const units: RecallUnit[] = []
  for (const block of result.long.blocks) {
    units.push({
      unitType: "overview",
      unitId: block.blockId,
      blockId: block.blockId,
      recalledContent: {
        title: block.title,
        summary: block.summary,
        overviewBody: block.overviewBody,
      },
    })
    for (const detail of block.details) {
      units.push({
        unitType: "detail",
        unitId: detail.detailId,
        blockId: block.blockId,
        recalledContent: { summary: detail.summary, body: detail.body },
      })
    }
  }
  return units
}

/** 把检索结果精简成交给模型的 JSON（只保留正文，去掉内部 ID/分数）。 */
export function formatReadResult(result: ReadSearchResult): ToolJsonValue {
  return {
    status: result.status,
    fast: result.fast.hits.map((hit) => ({
      title: hit.record.title,
      summary: hit.record.summary,
      body: hit.record.body,
    })),
    long: result.long.blocks.map((block) => ({
      title: block.title,
      summary: block.summary,
      overviewBody: block.overviewBody,
      details: block.details.map((detail) => ({ summary: detail.summary, body: detail.body })),
    })),
  }
}

/** 判断 memory-gate 节点结果是否 explicit=true。 */
export function isGateExplicit(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }
  return (value as { explicit?: unknown }).explicit === true
}

/** 判断 memory-gate 节点结果是否 available=true（本会话已绑定 active 记忆空间）。 */
export function isMemoryAvailable(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }
  return (value as { available?: unknown }).available === true
}

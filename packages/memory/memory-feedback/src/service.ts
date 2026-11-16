import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import "toy-storage-relational"
import type {
  RelationalAdapter,
  RelationalFilter,
  RelationalOperation,
} from "toy-storage-relational"
import { MemoryFeedbackError } from "./error.js"
import { KeyedLock } from "./lock.js"
import { assertFeedbackSchema, feedbackFromRow, feedbackRow, FEEDBACK_TABLE } from "./relational.js"
import { feedbackRelationalSchema } from "./schema.js"
import type {
  ConversationTurn,
  FeedbackOutcome,
  FeedbackScope,
  MemoryFeedbackConfig,
  RecallEntry,
  SettleSessionFeedbackInput,
  FeedbackValueEngine,
  JudgeSessionInput,
  RecallSnapshot,
  RecallUnit,
  ValueUnitType,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryFeedback: MemoryFeedback
  }
}

/** 一个去重后的价值单元，附带它的全部召回 Turn 和影响区间对话。 */
type RecallGroup = JudgeSessionInput

/**
 * 记忆价值反馈服务：Session 收尾时调用价值系统判断每个召回价值单元的态度，
 * 落库后供 Daily 巩固消费。价值系统通过 {@link registerValueEngine} 注入。
 */
export class MemoryFeedback extends Service {
  static inject = ["storage", "storageRelational"]

  private readonly sourceName: string
  private readonly locks = new KeyedLock()
  private source: RelationalAdapter | undefined
  private engine: FeedbackValueEngine | undefined

  /**
   * @param ctx 已挂载命名存储与关系型协议的 Cordis 上下文。
   * @param config 要使用的关系型存储实例名称。
   */
  constructor(ctx: Context, config: MemoryFeedbackConfig = {}) {
    super(ctx, "memoryFeedback")
    this.sourceName = config.sourceName ?? "main"
  }

  /** 核对 adapter 表结构；关系型实例不存在时拒绝初始化。 */
  [Service.init](): void {
    const source = this.ctx.storage.tryGet<RelationalAdapter>("relational", this.sourceName)
    if (source === undefined) {
      throw new MemoryFeedbackError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.sourceName}' 尚未就绪`,
      )
    }
    assertFeedbackSchema(source)
    this.source = source
  }

  /**
   * 注册唯一的价值系统插件。
   *
   * @param engine 负责态度判断（judgeSession）与价值计算（settle/initialize）的实现。
   * @returns 注销函数；调用后清空当前引擎。
   * @throws {MemoryFeedbackError} 已有引擎注册时抛出 engine-already-registered。
   */
  registerValueEngine(engine: FeedbackValueEngine): () => void {
    if (this.engine !== undefined) {
      throw new MemoryFeedbackError("engine-already-registered", "价值系统已注册")
    }
    this.engine = engine
    let disposed = false
    return () => {
      if (!disposed && this.engine === engine) {
        disposed = true
        this.engine = undefined
      }
    }
  }

  /**
   * Session 收尾：为每个召回价值单元调用价值系统判断态度并落库。
   *
   * 幂等：同一 Session 内同一价值单元已存在反馈时直接复用原记录，不重复调用价值系统。
   * 同一 Session 的收尾通过内部锁串行化，跨进程并发由唯一索引兜底。
   *
   * @param input 用户、空间、Session、召回记录与完整对话；signal 会透传给价值系统。
   * @returns 该 Session 的全部反馈记录（含历史已存在与本轮新增）。
   */
  async settleSessionFeedback(input: SettleSessionFeedbackInput): Promise<FeedbackOutcome[]> {
    nonEmpty(input.userId, "userId")
    nonEmpty(input.memorySpaceId, "memorySpaceId")
    nonEmpty(input.sessionId, "sessionId")
    const engine = this.requireEngine()
    return this.locks.with(`session:${input.sessionId}`, async () => {
      const existing = await this.listBySession(input.userId, input.memorySpaceId, input.sessionId)
      const existingKeys = new Set(existing.map((outcome) => unitKey(outcome)))
      const groups = groupRecalls(input.recalls, input.conversation)
      const outcomes = [...existing]
      const now = new Date().toISOString()
      for (const group of groups) {
        if (existingKeys.has(unitKey(group))) {
          continue
        }
        const judgement = await engine.judgeSession({
          ...group,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        const outcome: FeedbackOutcome = {
          feedbackId: randomUUID(),
          userId: input.userId,
          memorySpaceId: input.memorySpaceId,
          sessionId: input.sessionId,
          unitType: group.unitType,
          unitId: group.unitId,
          blockId: group.blockId,
          feedbackType: judgement.feedbackType,
          evidenceTurnNos: judgement.evidenceTurnNos,
          recallTurnNos: group.recallTurnNos,
          judgementData: judgement.judgementData,
          judgementVersion: judgement.judgementVersion,
          consumedBatchId: null,
          consumedAt: null,
          createdAt: now,
          updatedAt: now,
        }
        const operation = {
          type: "insert",
          table: FEEDBACK_TABLE,
          value: feedbackRow(outcome),
        } as const
        this.assertOperation(operation)
        await this.requireSource().execute(operation)
        outcomes.push(outcome)
      }
      return outcomes.sort(compareOutcome)
    })
  }

  /**
   * 读取某空间所有尚未被 Daily 巩固的反馈。
   *
   * @param scope 用户 + 记忆空间。
   * @returns 按创建时间升序的待巩固反馈。
   */
  async listPending(scope: FeedbackScope): Promise<FeedbackOutcome[]> {
    nonEmpty(scope.userId, "userId")
    nonEmpty(scope.memorySpaceId, "memorySpaceId")
    const result = await this.requireSource().execute({
      type: "find",
      table: FEEDBACK_TABLE,
      where: {
        type: "and",
        conditions: [
          eq("user_id", scope.userId),
          eq("memory_space_id", scope.memorySpaceId),
          { type: "isNull", field: "consumed_batch_id" },
        ],
      },
      orderBy: [{ field: "created_at", direction: "asc" }],
    })
    return result.rows.map(feedbackFromRow)
  }

  /**
   * 将一批反馈标记为已被某个 Daily 批次巩固。幂等：只影响尚未巩固的反馈。
   *
   * @param scope 反馈必须归属的用户 + 记忆空间。
   * @param batchId Daily 批次 ID，写入 consumed_batch_id。
   * @param feedbackIds 要标记的反馈 ID 列表。
   * @throws {MemoryFeedbackError} 任一 ID 不存在、已巩固或不属于该空间时抛出 invalid-state。
   */
  async markConsolidated(
    scope: FeedbackScope,
    batchId: string,
    feedbackIds: readonly string[],
  ): Promise<void> {
    nonEmpty(scope.userId, "userId")
    nonEmpty(scope.memorySpaceId, "memorySpaceId")
    nonEmpty(batchId, "batchId")
    if (feedbackIds.length === 0) {
      return
    }
    if (new Set(feedbackIds).size !== feedbackIds.length) {
      throw new MemoryFeedbackError("invalid-input", "feedbackIds 不能包含重复 ID")
    }
    for (const feedbackId of feedbackIds) {
      nonEmpty(feedbackId, "feedbackId")
    }
    const now = new Date().toISOString()
    const result = await this.requireSource().execute({
      type: "update",
      table: FEEDBACK_TABLE,
      where: {
        type: "and",
        conditions: [
          eq("user_id", scope.userId),
          eq("memory_space_id", scope.memorySpaceId),
          { type: "in", field: "feedback_id", values: feedbackIds },
          { type: "isNull", field: "consumed_batch_id" },
        ],
      },
      patch: {
        consumed_batch_id: batchId,
        consumed_at: now,
        updated_at: now,
      },
    })
    if (result.affectedRows !== feedbackIds.length) {
      throw new MemoryFeedbackError("invalid-state", "部分反馈不存在、已巩固或不属于该空间")
    }
  }

  private async listBySession(
    userId: string,
    memorySpaceId: string,
    sessionId: string,
  ): Promise<FeedbackOutcome[]> {
    const result = await this.requireSource().execute({
      type: "find",
      table: FEEDBACK_TABLE,
      where: {
        type: "and",
        conditions: [
          eq("user_id", userId),
          eq("memory_space_id", memorySpaceId),
          eq("session_id", sessionId),
        ],
      },
      orderBy: [{ field: "created_at", direction: "asc" }],
    })
    return result.rows.map(feedbackFromRow)
  }

  private requireSource(): RelationalAdapter {
    if (this.source === undefined) {
      throw new MemoryFeedbackError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.source
  }

  private requireEngine(): FeedbackValueEngine {
    if (this.engine === undefined) {
      throw new MemoryFeedbackError("engine-not-registered", "尚未注册价值系统插件")
    }
    return this.engine
  }

  private assertOperation(operation: RelationalOperation): void {
    this.ctx.storageRelational.assertOperation(feedbackRelationalSchema, operation)
  }
}

/**
 * 把召回记录按价值单元分组去重，并为每个单元构造召回影响区间内的对话。
 *
 * 影响区间（v2 §10.2）：单元第一次召回之后、Session 结束之前的所有对话轮次，
 * 都可能携带用户对该记忆的态度证据；具体是否相关由价值系统判断。
 */
function groupRecalls(
  recalls: readonly RecallEntry[],
  conversation: readonly ConversationTurn[],
): RecallGroup[] {
  const map = new Map<string, RecallSnapshot[]>()
  for (const entry of recalls) {
    for (const unit of entry.units) {
      assertRecallUnit(unit)
      const key = unitKey(unit)
      const snapshots = map.get(key) ?? []
      if (snapshots.some((snapshot) => snapshot.blockId !== unit.blockId)) {
        throw new MemoryFeedbackError("invalid-input", "同一价值单元的 blockId 不一致")
      }
      snapshots.push({ ...unit, turnNo: entry.turnNo, turnId: entry.turnId })
      map.set(key, snapshots)
    }
  }
  const sortedConversation = [...conversation].sort((a, b) => a.turnNo - b.turnNo)
  return [...map.values()].map((snapshots) => {
    snapshots.sort((a, b) => a.turnNo - b.turnNo || a.turnId.localeCompare(b.turnId))
    const { turnNo: firstRecall, turnId: _turnId, ...firstUnit } = snapshots[0]!
    const recallTurnNos = [...new Set(snapshots.map((snapshot) => snapshot.turnNo))]
    return {
      ...firstUnit,
      recallSnapshots: snapshots,
      recallTurnNos,
      recallAssistantTurns: sortedConversation
        .filter((turn) => recallTurnNos.includes(turn.turnNo))
        .map((turn) => ({ turnNo: turn.turnNo, assistantText: turn.assistantText })),
      relevantTurns: sortedConversation.filter((turn) => turn.turnNo > firstRecall),
    }
  })
}

/** 事件里的旧 ID-only 数据不能用于语义判断，缺正文时明确拒绝。 */
function assertRecallUnit(unit: RecallUnit): void {
  nonEmpty(unit.unitId, "unitId")
  nonEmpty(unit.blockId, "blockId")
  const content = unit.recalledContent
  if (typeof content !== "object" || content === null || typeof content.summary !== "string") {
    throw new MemoryFeedbackError("invalid-input", "召回单元缺少 recalledContent 正文快照")
  }
  if (unit.unitType === "overview") {
    if (
      unit.unitId !== unit.blockId ||
      typeof unit.recalledContent.title !== "string" ||
      typeof unit.recalledContent.overviewBody !== "string"
    ) {
      throw new MemoryFeedbackError("invalid-input", "overview 召回单元标识或正文快照无效")
    }
  } else if (unit.unitType !== "detail" || typeof unit.recalledContent.body !== "string") {
    throw new MemoryFeedbackError("invalid-input", "detail 召回单元类型或正文快照无效")
  }
}

function unitKey(unit: { readonly unitType: ValueUnitType; readonly unitId: string }): string {
  return `${unit.unitType}\u0000${unit.unitId}`
}

function compareOutcome(left: FeedbackOutcome, right: FeedbackOutcome): number {
  const keyCompare = unitKey(left).localeCompare(unitKey(right))
  return keyCompare !== 0 ? keyCompare : left.feedbackId.localeCompare(right.feedbackId)
}

function eq(field: string, value: string): RelationalFilter {
  return { type: "eq", field, value }
}

function nonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryFeedbackError("invalid-input", `${name} 必须是非空字符串`)
  }
}

export default MemoryFeedback

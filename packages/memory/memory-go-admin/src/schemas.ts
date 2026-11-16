import type { AdminJsonSchema } from "toy-admin"

/**
 * 各能力的 input/output JSON Schema（draft-07）。
 *
 * input 走 GET + query 串，因此数字/布尔都以字符串到达；output 精确描述
 * 返回的 JSON 形状，供管理端渲染并参与结果校验（`additionalProperties: false`）。
 */

const string: AdminJsonSchema = { type: "string" }
const nullableString: AdminJsonSchema = { type: ["string", "null"] }
const integer: AdminJsonSchema = { type: "integer" }

const DOMAINS = ["self", "person", "project", "topic", "entity", "event"]
const LIFECYCLES = ["active", "observing", "archived"]

// ─── 输入 Schema ──────────────────────────────────────────────────────────

export const listUsersInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: string,
    before: string,
  },
}

export const listUserOverviewInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId"],
  properties: {
    userId: { type: "string", minLength: 1 },
    includeDeleted: { type: "string", enum: ["true", "false"] },
  },
}

export const listFastInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memorySpaceId"],
  properties: {
    memorySpaceId: { type: "string", minLength: 1 },
    limit: string,
    beforeCreatedAt: string,
    beforeFastId: string,
    pendingOnly: { type: "string", enum: ["true", "false"] },
  },
}

export const getFastInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memorySpaceId", "fastId"],
  properties: {
    memorySpaceId: { type: "string", minLength: 1 },
    fastId: { type: "string", minLength: 1 },
  },
}

export const listLongInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memorySpaceId"],
  properties: {
    memorySpaceId: { type: "string", minLength: 1 },
    limit: string,
    beforeSortAt: string,
    beforeBlockId: string,
    domain: { type: "string", enum: [...DOMAINS] },
    lifecycle: { type: "string", enum: [...LIFECYCLES] },
    orderBy: { type: "string", enum: ["updatedAt", "createdAt"] },
  },
}

export const getLongInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memorySpaceId", "blockId"],
  properties: {
    memorySpaceId: { type: "string", minLength: 1 },
    blockId: { type: "string", minLength: 1 },
  },
}

// ─── 输出 Schema ──────────────────────────────────────────────────────────

const userSummarySchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId"],
  properties: { userId: string },
}

export const listUsersOutputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: { type: "array", items: userSummarySchema },
    nextCursor: string,
  },
}

const deviceBindingSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId", "deviceId", "memorySpaceId", "createdAt"],
  properties: {
    userId: string,
    deviceId: string,
    memorySpaceId: string,
    createdAt: string,
  },
}

const memorySpaceSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memorySpaceId", "userId", "name", "status", "createdAt", "updatedAt"],
  properties: {
    memorySpaceId: string,
    userId: string,
    name: nullableString,
    status: { type: "string", enum: ["active", "deleted"] },
    createdAt: string,
    updatedAt: string,
  },
}

export const listUserOverviewOutputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId", "devices", "spaces"],
  properties: {
    userId: string,
    devices: { type: "array", items: deviceBindingSchema },
    spaces: { type: "array", items: memorySpaceSchema },
  },
}

export const fastRecordSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "fastId",
    "writeId",
    "userId",
    "memorySpaceId",
    "sessionId",
    "turnId",
    "createdAt",
    "title",
    "titleKey",
    "summary",
    "body",
    "consumedBatchId",
    "consumedAt",
  ],
  properties: {
    fastId: string,
    writeId: string,
    userId: string,
    memorySpaceId: string,
    sessionId: string,
    turnId: string,
    createdAt: string,
    title: string,
    titleKey: string,
    summary: string,
    body: string,
    consumedBatchId: nullableString,
    consumedAt: nullableString,
  },
}

const fastCursorSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["createdAt", "fastId"],
  properties: { createdAt: string, fastId: string },
}

export const listFastOutputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "total", "pending", "consumed"],
  properties: {
    items: { type: "array", items: fastRecordSchema },
    nextCursor: fastCursorSchema,
    total: integer,
    pending: integer,
    consumed: integer,
  },
}

export const longBlockSummarySchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["blockId", "domain", "title", "aliases", "summary", "lifecycleStatus", "updatedAt"],
  properties: {
    blockId: string,
    domain: { type: "string", enum: [...DOMAINS] },
    title: string,
    aliases: { type: "array", items: string },
    summary: string,
    lifecycleStatus: { type: "string", enum: [...LIFECYCLES] },
    updatedAt: string,
  },
}

const longBlockCursorSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sortAt", "blockId"],
  properties: { sortAt: string, blockId: string },
}

export const listLongOutputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "total"],
  properties: {
    items: { type: "array", items: longBlockSummarySchema },
    nextCursor: longBlockCursorSchema,
    total: integer,
  },
}

const valueStateSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["valueData", "valueVersion"],
  properties: {
    valueData: {},
    valueVersion: string,
  },
}

const longDetailSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "detailId",
    "summary",
    "body",
    "lifecycleStatus",
    "value",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    detailId: string,
    summary: string,
    body: string,
    lifecycleStatus: { type: "string", enum: [...LIFECYCLES] },
    value: valueStateSchema,
    createdAt: string,
    updatedAt: string,
  },
}

export const longBlockSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "blockId",
    "domain",
    "title",
    "aliases",
    "summary",
    "overviewBody",
    "lifecycleStatus",
    "value",
    "details",
    "createdAt",
    "updatedAt",
    "contentUpdatedAt",
  ],
  properties: {
    blockId: string,
    domain: { type: "string", enum: [...DOMAINS] },
    title: string,
    aliases: { type: "array", items: string },
    summary: string,
    overviewBody: string,
    lifecycleStatus: { type: "string", enum: [...LIFECYCLES] },
    value: valueStateSchema,
    details: { type: "array", items: longDetailSchema },
    createdAt: string,
    updatedAt: string,
    contentUpdatedAt: string,
  },
}

export const runDailyInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memorySpaceId"],
  properties: {
    memorySpaceId: { type: "string", minLength: 1 },
  },
}

export const runDailyOutputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["batchId"],
  properties: {
    batchId: string,
  },
}

export const getDailyStatusInputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["batchId"],
  properties: {
    batchId: { type: "string", minLength: 1 },
  },
}

export const dailyStatusOutputSchema: AdminJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "batchId",
    "memorySpaceId",
    "status",
    "checkpointStage",
    "startedAt",
    "committedAt",
    "finishedAt",
  ],
  properties: {
    batchId: string,
    memorySpaceId: string,
    status: {
      type: "string",
      enum: ["waiting_gate", "running", "committing", "reconciling", "succeeded", "failed", "abandoned"],
    },
    checkpointStage: integer,
    startedAt: nullableString,
    committedAt: nullableString,
    finishedAt: nullableString,
  },
}

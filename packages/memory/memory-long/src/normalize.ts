/**
 * 匹配 key 规范化：Unicode NFKC + 英文小写 + 首尾空白清理。
 *
 * 用于 Long 的 title / alias / keyword 与检索 Query 的“完全匹配”相等比较
 * （v2 §9.4），不参与包含、编辑距离或分词。原始文本保留在记录里供展示，
 * 规范化后的 key 仅供匹配。
 */
export function normalizeKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim()
}

/**
 * 派生向量记录 ID。向量集合中块 summary 与细节 summary 平级存放，
 * 用 `block:` / `detail:` 前缀区分，避免两套 ID 空间冲突。
 */
export function vectorRecordId(kind: "block" | "detail", id: string): string {
  return `${kind}:${id}`
}

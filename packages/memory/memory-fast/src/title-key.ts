/**
 * 标题规范化：Unicode NFKC + 英文小写 + 首尾空白清理。
 *
 * 只用于“完全匹配”相等比较（v2 §7.3 / §9.4），不参与包含、编辑距离
 * 或分词检索。原始 `title` 保留在记录里供浏览和展示，`title_key` 仅供匹配。
 */
export function normalizeTitleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().trim()
}

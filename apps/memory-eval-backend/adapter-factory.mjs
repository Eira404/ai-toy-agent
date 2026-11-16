/**
 * 按名称创建 adapter 实例（cli 与 serve 共用）。
 */
import { InternalAdapter } from "./adapters/internal.ts"
import { LongMemEvalV1Adapter } from "./adapters/longmemeval_v1.ts"

/**
 * @param {object} opts
 * @param {string} opts.adapter internal | longmemeval_v1
 * @param {string} [opts.data] longmemeval 数据文件路径
 * @param {number} [opts.start]
 * @param {number} [opts.limit]
 */
export function createAdapter(opts) {
  const start = opts.start ?? 0
  const limit = opts.limit
  const name = opts.adapter
  if (name === "internal") {
    return new InternalAdapter({ start, limit })
  }
  if (name === "longmemeval_v1") {
    if (opts.data === undefined || opts.data === "") {
      throw new Error("longmemeval_v1 需要 data 参数（数据文件路径）")
    }
    return new LongMemEvalV1Adapter({ dataFile: opts.data, start, limit })
  }
  throw new Error(`未知 adapter：${name}（支持 internal / longmemeval_v1）`)
}

/**
 * 引擎业务错误：invalid-input 为调用参数，invalid-state 为数值 JSON，
 * invalid-judgement 为反馈/证据不一致；两个 unsupported-* 为版本不兼容，
 * model-failed 为模型调用或模型输出结构失败。配置校验错误由 Zod 直接抛出。
 */
export type ValueEngineErrorCode =
  | "invalid-input"
  | "invalid-state"
  | "invalid-judgement"
  | "unsupported-value-version"
  | "unsupported-judgement-version"
  | "model-failed"

/** 调用方可用 instanceof + code 分流处理，cause 保留底层错误；取消原因通常直接传播。 */
export class ValueEngineError extends Error {
  /** @param code 稳定的错误分类；不要依赖 message 文案做业务判断。 */
  constructor(
    readonly code: ValueEngineErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ValueEngineError"
  }
}

import type { Scope } from "toy-memory-long"

/**
 * Dream Gate 契约：Weekly 依赖，由 Runtime（会话层）实现。
 *
 * 「禁止新建 Session」的能力属于 Runtime；Weekly 只依赖这一协作契约：
 * - `acquire`：等待该记忆空间排空后锁定，返回本次占用的凭证。
 * - `release`：幂等释放。
 *
 * 组合流程中前置 Daily 与 Weekly 全程持有同一 Gate，因此 `acquire` 只调用一次。
 */
export interface DreamGate {
  acquire(scope: Scope): Promise<string>
  release(scope: Scope, credential: string): Promise<void>
}

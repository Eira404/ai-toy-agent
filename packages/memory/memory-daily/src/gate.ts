import type { Scope } from "toy-memory-fast"

/**
 * Dream Gate 契约：Daily 依赖，由 Runtime（会话层）实现。
 *
 * 「禁止新建 Session」的能力属于 Runtime；Daily 只依赖这一协作契约：
 * - `acquire`：等待该记忆空间排空（无活跃 / 正在结束的 Session）后锁定，
 *   返回本次占用的凭证。实现方应保证「禁止新建 Session」与「获取 Gate」原子。
 * - `release`：幂等释放；实现方在确认释放前保持禁止新建 Session。
 *
 * 未注册 Gate 时 `runDaily` 直接执行（供测试/单机环境使用）。
 */
export interface DreamGate {
  acquire(scope: Scope): Promise<string>
  release(scope: Scope, credential: string): Promise<void>
}

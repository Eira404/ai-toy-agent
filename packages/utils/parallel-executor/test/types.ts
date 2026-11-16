import type { Context } from "cordis"
import type { TaskContext, TaskResult } from "../src/index.js"

/** 编译期验证使用方的泛型推导、联合结果收窄和 Cordis Context 扩展。 */
export async function checkPublicTypes(ctx: Context): Promise<number[]> {
  ctx.parallelExecutor.registerPool("types", { maxConcurrency: 2 })
  const single: number = await ctx.parallelExecutor.run((task: TaskContext) => task.attempt, {
    pool: "types",
  })
  const mapped: number[] = await ctx.parallelExecutor.map(
    [1, 2],
    (item, task) => item + task.index,
    { pool: "types" },
  )
  const results: TaskResult<string>[] = await ctx.parallelExecutor.mapSettled(
    mapped,
    async (item) => String(item),
    { pool: "types" },
  )
  for (const result of results) {
    if (result.status === "fulfilled") {
      const text: string = result.value
      mapped.push(text.length)
      // @ts-expect-error 成功结果不能读取失败分支属性。
      void result.error
    }
  }
  // @ts-expect-error 任务必须显式指定池。
  void ctx.parallelExecutor.run(() => 1, {})
  // @ts-expect-error 不接受已启动的 Promise。
  void ctx.parallelExecutor.run(Promise.resolve(1), { pool: "types" })
  return [single, ...mapped]
}

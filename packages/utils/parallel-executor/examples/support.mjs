/** 为池覆盖示例提供显式启动/释放时机，避免依赖固定延时推测运行状态。 */
export function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

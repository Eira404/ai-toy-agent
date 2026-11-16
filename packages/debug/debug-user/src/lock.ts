/** 只在同一插件实例内串行化相同键的操作；不提供跨进程分布式锁。 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * @param key 需要串行化的业务键，例如 userId。
   * @param run 取得该键的执行权后运行的异步操作。
   * @returns run 的返回值；失败时仍会释放该键。
   */
  async with<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key)
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(key, tail)
    await prior
    try {
      return await run()
    } finally {
      release()
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    }
  }
}

/** 按 Session 或用户设备串行化当前进程内的状态变更。 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * @param key 需要互斥的 Session 或用户设备键。
   * @param run 持锁期间运行的操作。
   * @returns 操作的返回值；失败时也释放锁。
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

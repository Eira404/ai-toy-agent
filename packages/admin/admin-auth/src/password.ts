import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { AdminAuthError } from "./error.js"

// OWASP scrypt 配置之一：N=2^15, r=8, p=3；盐 16 字节，结果 32 字节。
const PREFIX = "scrypt$32768$8$3$"
const DUMMY = `${PREFIX}${"00".repeat(16)}$${"00".repeat(32)}`

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error !== null) {
        reject(error)
      } else {
        resolve(key)
      }
    })
  })
}

/** 限制昂贵计算的在途数量，不创建无界等待队列。 */
export class PasswordHasher {
  private active = 0

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      throw new AdminAuthError("auth-busy", "密码服务繁忙，请稍后重试")
    }
    this.active += 1
    try {
      return await work()
    } finally {
      this.active -= 1
    }
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await derive(password, salt)
    return `${PREFIX}${salt.toString("hex")}$${key.toString("hex")}`
  }

  /** 不存在的账号也执行同规格计算；损坏的存储哈希拒绝认证。 */
  async verify(password: string, encoded: string = DUMMY): Promise<boolean> {
    const valid = /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(encoded)
    const parts = (valid ? encoded : DUMMY).split("$")
    const actual = await derive(password, Buffer.from(parts[4]!, "hex"))
    const matches = timingSafeEqual(actual, Buffer.from(parts[5]!, "hex"))
    return valid && matches
  }
}

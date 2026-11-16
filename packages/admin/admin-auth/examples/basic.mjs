/* global console */
import { ROOT, PASSWORD, setup } from "../test/helpers.mjs"

// 自包含演示使用内存测试 adapter，无需数据库或网络；生产接入见 README。
const app = await setup()
try {
  const first = await app.auth.bootstrap(ROOT)
  const login = await app.auth.login(ROOT)
  const second = await app.auth.createAdmin(login.token, {
    loginName: "operator",
    password: PASSWORD,
    displayName: "值班管理员",
    role: "admin",
  })
  console.log("初始化管理员：", first.loginName)
  console.log("新增管理员：", second.loginName)
  console.log("当前身份：", (await app.auth.authenticate(login.token)).admin.loginName)
  console.log("管理员数量：", (await app.auth.listAdmins(login.token)).items.length)
  await app.auth.logout(login.token)
  try {
    await app.auth.authenticate(login.token)
  } catch (error) {
    console.log("退出后：", error.code)
  }
} finally {
  await app.dispose()
}

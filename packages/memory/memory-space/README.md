# toy-memory-space

记忆空间元数据管理。用户创建空间、给空间起名、软删除空间，并把娃娃（device）绑定到空间；上层通过 `resolveMemorySpace` 解析娃娃当前的 active 空间。

本包只负责空间与绑定关系，不接 Session，也不生成记忆内容。Session 预处理阶段由上层调用 `resolveMemorySpace` 并把结果写入 Session payload。

## 数据模型

两张关系表，由宿主合并到命名关系型实例：

| 表 | 职责 |
|---|---|
| `toy_memory_spaces` | 空间主表：`status` 软删除标记（`active`/`deleted`），删除只改状态、不删绑定 |
| `toy_memory_space_devices` | 娃娃绑定表：`(user_id, device_id)` 唯一，保证一娃娃一空间 |

- 空间身份由 `(userId, memorySpaceId)` 确定：`userId` 是创建者（所有者），`memorySpaceId` 由程序生成。
- 娃娃身份由 `(userId, deviceId)` 成对确定（与 Session 的 `ownerKey` 口径一致）。
- 软删除只改 `status`，绑定关系原样保留，恢复后娃娃自动回到该空间。

## 方法

| 方法 | 说明 |
|---|---|
| `createSpace(input)` | 创建 active 空间，可带名字 |
| `getSpace(memorySpaceId)` | 按 ID 读空间（含已删），不存在返回 null |
| `listSpaces(userId, options?)` | 列某用户的空间，默认只列 active |
| `renameSpace(userId, memorySpaceId, name)` | 设置/修改名字，空串清空为 null |
| `deleteSpace(userId, memorySpaceId)` | 软删除（标记 deleted），幂等 |
| `restoreSpace(userId, memorySpaceId)` | 恢复为 active，幂等 |
| `bindDevice(input)` | 绑定/改绑娃娃到空间（幂等） |
| `unbindDevice(userId, deviceId)` | 解绑娃娃，不存在抛 `binding-not-found` |
| `listBoundDevices(memorySpaceId)` | 列空间下的娃娃 |
| `resolveMemorySpace(userId, deviceId)` | 解析娃娃当前 active 空间，未绑定或已删返回 null |
| `countSpaces(userId, options?)` | 统计空间数 |
| `countDevices(memorySpaceId)` | 统计娃娃数 |

```ts
interface CreateSpaceInput { userId: string; name?: string }
interface BindDeviceInput { userId: string; deviceId: string; memorySpaceId: string }
interface MemorySpace {
  memorySpaceId: string
  userId: string
  name: string | null
  status: "active" | "deleted"
  createdAt: string
  updatedAt: string
}
```

## 配置

```ts
interface SpaceConfig {
  relationalSource?: string   // 关系型实例名，默认 "main"
  maxNameLength?: number       // 空间名上限，默认 64
  now?: () => string           // 时间源注入，测试用
}
```

## 挂载

宿主先挂命名存储与关系型 adapter（PostgreSQL），再挂 `MemorySpaceService`：

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { MemorySpaceService, spaceRelationalSchema } from "toy-memory-space"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  schema: spaceRelationalSchema, // 宿主合并各业务包的关系表
})
await ctx.plugin(MemorySpaceService)
```

挂载后通过 `ctx.memorySpace` 调用。

## 示例与测试

```sh
npm run example -w toy-memory-space
npm test -w toy-memory-space
```

示例使用内存 mock 演示创建/改名/软删空间与娃娃绑定；测试覆盖名字归一化、归属校验、软删恢复、绑定改绑、解绑与 active 空间解析。

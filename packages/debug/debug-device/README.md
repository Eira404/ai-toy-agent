# toy-debug-device

仅供 debug 使用的「玩偶（设备）」表定义及创建方法，作为 Cordis 类插件挂载到 `ctx.debugDevices`。生产环境的用户/设备数据由其他系统维护。

## 职责

- 导出 `devicesRelationalSchema`，定义 `toy_devices` 表。
- 通过名称调用已连接的关系型 adapter，提供 `createDevice` / `ensureDevice` / `seedDevices` / `getDevice` / `listDevices` / `updateDevice` / `deleteDevice`。
- 所有写入同步落库，不依赖写入队列。

## 注册

```js
import { DebugDevices, devicesRelationalSchema } from "toy-debug-device"

await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString,
  createMissing: true,
  schema: { tables: { ...devicesRelationalSchema.tables } },
})
await ctx.plugin(DebugDevices, { sourceName: "main" })
```

## 表结构

`toy_devices`：`device_id`（主键）、`user_id`（可空）、`display_name`、`note`、`persona`（可空，玩偶人设文本）、`age`（integer 可空，使用该玩偶的孩子年龄/岁）、`payload`（json）、`created_at`、`updated_at`。

- 一个用户可有多个玩偶，每个玩偶各自记录使用它的孩子年龄（`age`）与人设（`persona`）。
- `age` 存岁数（`0–150` 的宽松合理性边界，`null` 表示未知）。

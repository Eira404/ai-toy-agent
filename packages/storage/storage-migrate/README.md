# toy-storage-migrate

> 目录 `packages/storage/storage-migrate`

声明式 PostgreSQL 迁移工具：以逻辑 Schema（`RelationalSchemaDefinition`）为**目标态**，对比物理库结构，
自动生成并应用**加法**变更（建表 / 加列 / 加索引）。破坏性变更只报告、不自动执行。

## 定位

- **不挂在后端启动**，作为独立命令运行（`plan` / `apply`）。
- 只做 DDL + 确定性 DML 回填；依赖模型的数据初始化（如价值数值）不在这里做。

## 命令

```bash
node packages/storage/storage-migrate/lib/cli.js plan   --schema schema.json [--schema-name public]
node packages/storage/storage-migrate/lib/cli.js apply  --schema schema.json [--schema-name public]
```

- 环境变量：`DATABASE_URL`。
- `--schema`：目标 Schema 的 JSON 文件（即 `RelationalSchemaDefinition` 序列化结果，
  可用 `JSON.stringify(buildRelationalSchema({ debugBackend }))` 生成）。

## 库 API

```ts
import { Pool } from "pg"
import { planMigrations, applyMigrations } from "toy-storage-migrate"

await planMigrations(pool, desired, { schemaName: "public" })   // 只生成计划
await applyMigrations(pool, desired, { schemaName: "public" })  // 一个事务内执行
```

## 列字段扩展

`RelationalColumnDefinition` 支持两个迁移提示：

| 字段 | 含义 | 生成 SQL |
|---|---|---|
| `default` | 常量默认值 | `ADD COLUMN ... DEFAULT <default>` |
| `backfill` | 存量行回填表达式 | 加列 → `UPDATE SET c = <backfill>` →（非空则）`SET NOT NULL` |

非空新列既没有 `default` 也没有 `backfill` 时，diff 只报告 `notNullWithoutDefault`，不执行。

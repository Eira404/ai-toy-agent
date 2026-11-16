# toy-storage

通用存储实例的 Cordis 类插件。`ctx.storage` 只管理已就绪实例的注册、查找和卸载，
不连接数据库，也不定义关系型或向量型的操作方式。

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"

const ctx = new Context()
await ctx.plugin(ToyStorage)

// 后端插件中：
const unregister = ctx.storage.register("relational", "main", adapter)

// 消费者插件中：
const database = ctx.storage.get<RelationalAdapter>("relational", "main")
```

同一 `kind` 内名称必须唯一；不同 `kind` 可以使用相同名称。注册跟随后端插件的
Cordis Fiber 自动撤销，也可以调用 `unregister()` 提前撤销。后端连接的关闭仍由
创建该实例的插件负责。`get<T>()` 的泛型仅表示调用方期望的类型，运行时不验证
实例是否实现了该协议，后续具体 adapter 插件必须保证注册类型正确。

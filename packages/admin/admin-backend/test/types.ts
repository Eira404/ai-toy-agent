import type { AdminOperationDefinition } from "toy-admin"
import { httpBinding } from "../src/index.js"

const operation: AdminOperationDefinition = {
  name: "example.typed",
  description: "验证绑定能直接交给总包",
  kind: "query",
  roles: ["viewer"],
  bindings: [httpBinding({ method: "POST", path: "/example/typed" })],
  input: true,
  execute: () => null,
}
void operation

function invalidBindings(): void {
  // @ts-expect-error 方法必须使用当前支持的大写值。
  httpBinding({ method: "post", path: "/example" })
  // @ts-expect-error 适配器尚未支持 SSE，不能对外声称可用。
  httpBinding({ method: "GET", path: "/example", responseMode: "sse" })
  // @ts-expect-error 缺少 path。
  httpBinding({ method: "POST" })
  // @ts-expect-error 字段拼写错误。
  httpBinding({ method: "POST", path: "/example", inputSouce: "body" })
}
void invalidBindings

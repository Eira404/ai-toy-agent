import type { Admin, AdminOperationDefinition } from "../src/index.js"

interface Input {
  readonly value: number
}
interface Output {
  readonly doubled: number
}

const definition: AdminOperationDefinition<Input, Output> = {
  name: "example.double",
  description: "演示类型约束",
  roles: ["admin"],
  kind: "query",
  bindings: [{ transport: "http", method: "POST", path: "/example/double" }],
  input: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
  execute: (input, context) => {
    const id: string = context.identity.admin.adminId
    void id
    // @ts-expect-error 原始凭据不能进入业务上下文。
    void context.token
    // @ts-expect-error 身份上下文不可替换。
    context.identity = { ...context.identity }
    return { doubled: input.value * 2 }
  },
}

function use(admin: Admin): void {
  admin.register(definition)
  const result: Promise<Output> = admin.execute<Output, Input>("example.double", {
    token: "opaque",
    input: { value: 2 },
  })
  void result
  // @ts-expect-error 未知角色不能注册。
  admin.register({ ...definition, roles: ["root"] })
  // @ts-expect-error 输入泛型限制调用 DTO。
  void admin.execute<Output, Input>("example.double", { token: "opaque", input: { value: "2" } })
}
void use

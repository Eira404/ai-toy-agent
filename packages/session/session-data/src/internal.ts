/** 包内访问可选持久化服务的 Symbol；不从包入口导出给业务调用方。 */
export const sessionPersistence = Symbol("sessionData.persistence")
export const requireSessionPersistence = Symbol("sessionData.requirePersistence")
/** 包内发布数据变化的 Symbol；业务方只需通过 Cordis 订阅事件。 */
export const publishSessionDataChange = Symbol("sessionData.publishChange")

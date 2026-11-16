/** 标识存储能力的类别，例如 relational 或未来的 vector。 */
export type StorageKind = string

/** 一项已经注册并可被其他插件查找的存储实例。 */
export interface StorageEntry<T extends object = object> {
  readonly kind: StorageKind
  readonly name: string
  readonly instance: T
}

/** 注册完成后可主动撤销的句柄；插件卸载时也会自动撤销。 */
export type StorageRegistration = () => void

/** 用于列表和诊断的不可变注册信息，不暴露实例本体。 */
export interface StorageDescriptor {
  readonly kind: StorageKind
  readonly name: string
}

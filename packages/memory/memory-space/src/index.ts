export { MemorySpaceService, MemorySpaceService as default } from "./service.js"
export { MemorySpaceError } from "./error.js"
export type { MemorySpaceErrorCode } from "./error.js"
export { spaceRelationalSchema, SPACES_TABLE, DEVICES_TABLE } from "./schema.js"
export type { SpaceConfig, ResolvedSpaceConfig } from "./config.js"
export type {
  BindDeviceInput,
  CreateSpaceInput,
  DeviceBinding,
  ListSpacesOptions,
  MemorySpace,
  SpaceStatus,
} from "./types.js"

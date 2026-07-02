/**
 * @paw/settings 包的公共入口。
 *
 * ## 功能概览
 * 本包提供 Paw 项目的配置加载、保存、校验与凭据解析能力。
 *
 * ## 模块组织
 * - `load.ts` —— 配置文件的磁盘读写（load/save/default path）
 * - `schema.ts` —— Zod schema 定义（配置结构描述与类型推导）
 * - `credentials.ts` —— 多 AI 提供商的 API Key/Base URL/Model 解析
 *
 * ## 导出说明
 * - 配置 CRUD：`loadPawSettingsLocal` / `savePawSettingsLocal` / `defaultSettingsPath`
 * - 脱敏工具：`redactSettingsForDisplay` / `redactSecrets`
 * - Schema 与类型：`pawSettingsLocalSchema` / `modelConfigSchema` 等
 * - 凭据解析：`resolveApiKey` / `resolveBaseUrl` / `resolveModel` / `hasApiKey`
 */

// 配置加载与持久化
export {
  defaultSettingsPath,
  loadPawSettingsLocal,
  redactSettingsForDisplay,
  savePawSettingsLocal,
} from "./load.js";
// Schema 与派生类型
export {
  type PawSettingsLocal,
  pawSettingsLocalSchema,
  modelConfigSchema,
  type ModelConfig,
} from "./schema.js";
// 凭据解析与脱敏
export {
  hasApiKey,
  redactSecrets,
  resolveApiKey,
  resolveBaseUrl,
  resolveModel,
  type CredentialProvider,
} from "./credentials.js";

/**
 * Ambient 声明：@copilotkit/runtime 的 `./v2` 子路径在 exports 里没有 `types` 字段，
 * 且本项目 tsconfig 用经典 `node` moduleResolution，无法解析其 .d.cts。
 * 这里只声明实际用到的 BuiltInAgent（运行期由 @copilotkit/runtime/dist/v2 提供）。
 */
declare module '@copilotkit/runtime/v2' {
  export class BuiltInAgent {
    constructor(config: { model: unknown; [key: string]: unknown });
  }
}

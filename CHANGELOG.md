# Changelog

## [0.1.0] - 2026-11-02

首个版本。

- 按启动目录（`ctx.cwd` 的绝对路径）隔离记忆，存在 `getAgentDir()/memory/<可读路径编码>/`。
- 会话开始时预建目录，并快照 `MEMORY.md` 索引；每次请求注入系统提示词的 `memory` 与 `memory_index` 两段。
- 读取超过 48 小时的记忆时附加时效提醒，同时覆盖文本形式的 `structuredContent`，codemode 中的嵌套读取同样生效。
- 不注册工具，不修改 pi 配置，不联网，不自动保存或召回。

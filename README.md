# pi-cwd-memory

按启动目录隔离的文件式记忆扩展。插件准备目录、注入上下文，并为读取旧记忆附加时效提醒。不注册工具，不负责保存、整理或修改记忆。

## 加载

在本目录运行：

```bash
pi -e ./index.ts
```

需要持久启用时，可自行执行 `pi install /绝对路径/29-pi-memory`。本项目不会自动修改 pi 配置。

## 存储

默认位置：

```text
~/.pi/agent/memory/<启动目录的可读路径编码>/
├── MEMORY.md
└── 各条记忆.md
```

使用 pi 的 `getAgentDir()`，因此也遵循 `PI_CODING_AGENT_DIR` 设置。记忆不放入项目工作区，也不与 session 文件混放。不同启动目录（包括同一仓库内的子目录）独立存储。

目录命名沿用 pi 的 session 规则：移除绝对路径开头的分隔符，将 `/`、`\`、`:` 替换为 `-`，首尾各加 `--`。例如 `/Users/ziqian/project` 对应 `--Users-ziqian-project--`。

旧版哈希目录不会自动迁移或删除；如已有记忆，需手动移到新目录后重新进入会话或执行 `/reload`。

启动时仅预建目录，不创建空的 `MEMORY.md`。

## 上下文与缓存

- `session_start`：读取 `memory-prompt.md`，将 `{{MEMORY_DIR}}` 替换为绝对记忆目录；读取完整的 `MEMORY.md`，加上 `Contents of <绝对索引路径> (user's auto-memory, persists across conversations):` 来源说明后生成快照。索引不存在或为空则不加载，不修改磁盘上的索引。
- `before_agent_start`：将同一份快照设置到系统提示词的 `memory` 和 `memory_index` 分区，不读取磁盘，不追加聊天消息。
- 会话内即使修改索引、记忆正文或提示词文件，插件也不刷新快照。重新进入会话或执行 `/reload` 才重新读取。
- 只预载索引，不预载各条记忆正文。正文由 Agent 使用现有工具按需读取。
- 插件不因记忆文件变化而改变提示词前缀；pi 自身的压缩、工具切换等行为不由本插件控制。

`memory-prompt.md` 使用 `{{MEMORY_DIR}}` 路径占位符，并将工具名称调整为 `write` / `apply_patch`，兼容两种 pi 工具配置。其余文字保留参考原文，不注册额外工具。

不注入 `node_type`、`originSessionId` 或 `modified` 元数据。

## 旧记忆读取提醒

- 使用 `tool_result` 钩子，仅处理当前记忆目录内文件的成功 `read` 结果。
- 根据文件最后修改时间（mtime）计算完整天数；满 48 小时起，在原读取文本前添加 `<system-reminder>This memory is N days old. ...</system-reminder>`，提醒核实当前状态。
- 同步更新文本形式的 `structuredContent`，使 codemode 中的嵌套 `read` 也能收到提醒。
- 手动读取 `MEMORY.md` 也适用；初始化时直接加载索引不经过工具，不附加年龄提醒。
- 不修改文件、历史消息或系统快照；无法获取 mtime 时保留原读取结果。不实现自动召回。

## 验证

需要 Node.js 22.19 或更新版本，无需安装依赖即可运行：

```bash
npm test
```

## 安装

```bash
pi install npm:@runminton/pi-cwd-memory
```

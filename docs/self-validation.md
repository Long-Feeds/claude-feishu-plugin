# 开发自验证

改完 daemon / shim / hook 后的**内环自验证**流程。跟 `test-checklist.md`（发布前
完整 QA）、`smoke.md`（冒烟）是三兄弟 —— 本文负责 commit 前的快速回路。

单测（`bun test`）只覆盖纯逻辑；运行时的 plugin 加载顺序、socket 重连、hook
触发先后、tmux 注入时序 这些 stateful 行为只有走完整条路径才会暴露。以下两种
方法组合起来可以**完全不需要人为参与**跑出闭环。

## 方法 1：fork 一个新的 `claude` 子进程

**适用**：测 register / UserPromptSubmit / Stop hook / announce title / session
去重 —— 任何从「终端侧」触发的路径。

```bash
TESTCWD=$(mktemp -d /tmp/claude-test-XXXXXX)
cd "$TESTCWD" && claude --print --dangerously-skip-permissions \
  "<描述你这次要验证什么行为的 prompt>"
```

三条日志拼起来就是完整结果：
- `journalctl --user -u claude-feishu --since "60 seconds ago" -o cat` — daemon 侧
- `tail -20 $HOME/.claude/channels/feishu/hook-debug.log` — hook 侧
- `cat $HOME/.claude/channels/feishu/threads.json` — 持久状态

说明：
- `--print` 让 claude 跑完一轮就退，大多数改动的最小验证单元就是一轮。多轮
  可以用 tmux + send-keys，或不加 `--print` 走 stdin。
- 测 MCP 实验能力（比如 permission 通道）才需要加
  `--dangerously-load-development-channels plugin:feishu@claude-feishu`；测
  hook / register / announce 不需要。
- 需要验证「忽略 vibe-kanban」这类基于 cwd 的分支，`mktemp -d
  /var/tmp/vibe-kanban/worktrees/test-XXXXXX` 就能造一个假的 kanban cwd。

## 方法 2：用 `lark-cli` 在群里主动发消息

**适用**：测入站 feishu 事件 —— gate 判断、feishu-spawn、`react` /
`reply_in_thread` 路由、permission 回复。`lark-cli` 以 bot 身份发消息，**不需要
真人坐在飞书前面**。

```bash
BOT_OPEN_ID=ou_7604a4f0196467afdd57b1cfb714132a
TEST_CHAT=oc_7e62519348fcd9c524805fbb4819dd2f

# 顶层消息（触发 feishu-spawn）
lark-cli im +messages-send --chat-id "$TEST_CHAT" \
  --text "<at user_id=\"$BOT_OPEN_ID\">bot</at> 测试 prompt" --as bot

# 回复已有消息 / thread
lark-cli im +messages-reply --message-id om_xxx \
  --text "<at user_id=\"$BOT_OPEN_ID\">bot</at> 追问" --reply-in-thread --as bot
```

验证的数据源跟方法 1 一样（journalctl + hook-debug.log + threads.json）。

## 组合

多数端到端场景两种都要用，比如「操作者从飞书 spawn 一个 session → 收到 permission
prompt → 回复 y 放行」：方法 2 发最初触发消息 → daemon 自动 fork claude（隐式走
方法 1 的路径）→ 方法 2 再发一条 `y <code>`。整条链上一个人都不用在终端/飞书坐着。

## 注意事项

- 改完代码必须先 `bun sync` 再测，否则 daemon 跑的是 plugin cache 里的旧代码
  （`CLAUDE.md` 已说明）。
- 方法 1 跑完要手动清 `/tmp/claude-test-*` 或 `/var/tmp/vibe-kanban/worktrees/test-*`
  残留 cwd，否则 `pendingRoots` 会留痕（1 小时 TTL 会自动收掉，不急）。
- 方法 2 发的消息会留在群里，测完可自行删除或忽略 —— 有些场景（新 thread）
  删不掉，可用已有无关 thread 测 follow-up 路径。

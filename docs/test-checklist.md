# 本地开发 Test Checklist

每次改完代码，走完这份 checklist 才算本轮开发完成。两大场景 + 若干 pre-flight。

## 变量

```bash
# 替换成你环境里的实际值
BOT_OPEN_ID=ou_7604a4f0196467afdd57b1cfb714132a
TEST_CHAT=oc_7e62519348fcd9c524805fbb4819dd2f
STATE_DIR=$HOME/.claude/channels/feishu
```

## Pre-flight（1 分钟内跑完）

| # | 检查 | 命令 | 预期 |
|---|---|---|---|
| P1 | 单测全绿 | `bun test` | `0 fail`，数量 ≥ 50 |
| P2 | 代码同步到 plugin cache + marketplace | `bun sync` | 两个 rsync + 1 systemd restart 成功 |
| P3 | daemon 活 | `systemctl --user is-active claude-feishu` | `active` |
| P4 | WS 连接 | `journalctl --user -u claude-feishu -n 30 \| grep "WebSocket connected"` | 有近期 hit |
| P5 | hubChatId 已设 | `python3 -c "import json; print(json.load(open('$STATE_DIR/access.json')).get('hubChatId'))"` | 非空；通常 = TEST_CHAT |
| P6 | TEST_CHAT 已白名单 | `python3 -c "import json; d=json.load(open('$STATE_DIR/access.json')); print('$TEST_CHAT' in d['groups'])"` | `True` |
| P7 | 群内 `im.message.receive_v1` scope 有效 | 在群里 @bot 一次（下面 B1），daemon 收到事件 | `journalctl ... grep 'inbound event'` 里有这条 |

## 场景 A — Terminal session 动态同步到飞书（同 session 共 thread）

手工开一个终端 claude，确认它能主动把消息投递到飞书群，并把多条消息收敛到同一个话题。

| # | 操作 | 预期 | 验证命令 |
|---|---|---|---|
| A1 | 在新终端里 `cd ~/workspace/sandbox && claude`（随便一个目录） | shim 向 daemon 注册 | `journalctl --user -u claude-feishu -f` 出现 `terminal auto-announce session=... hub=$TEST_CHAT msg=<om_xxx>` |
| A2 | 飞书群里看 | 出现一条 root：`🟢 Claude Code session online — cwd: <目录>` | lark-cli `im +messages-get --message-id <om_xxx>` 拿到内容 |
| A3 | 在该 claude 里输入 `用 reply 工具向飞书发一句 "hello A3"` | Claude 调 `reply`，消息以 reply_in_thread=true seed 一个 thread 在 A2 那条 root 下 | `cat $STATE_DIR/threads.json` 多出一条 `origin:"terminal" status:"active"` |
| A4 | 再输入 `再 reply 一句 "hello A4"` | Claude 再调 `reply`，daemon 走 `in_thread seed=false`，进**同一个** thread | 该 thread 现在 3 条消息（announce root + A3 + A4），`threads.json` 里 thread_id 不变、`last_message_at` 前进 |
| A5 | daemon 重启后 session 不重复 announce | `systemctl --user restart claude-feishu` → 5 秒后看日志 | **不**再出现 `terminal auto-announce session=<原 id>`（shim 带着原 session_id 重连，daemon 走 `alreadyBound / alreadyPending` 分支跳过） |

> A5 只对 **新起的** terminal claude 成立（shim 代码有 `let sessionId` 持久化修复）。历史上用旧 shim 启动的 claude，重启 daemon 仍然会重 announce 直到它本身冷启动。

## 场景 B — 群内新开话题 → 表情确认 → feishu-spawn session

用 lark-cli 模拟用户在话题群里 @bot 起一个新话题，走完表情回复 + Y-b spawn + 多轮 in-thread。

```bash
at() { echo "<at user_id=\"$BOT_OPEN_ID\">bot</at>"; }
```

| # | 操作 | 预期 | 验证 |
|---|---|---|---|
| B1 | 发一个全新话题：`lark-cli im +messages-send --chat-id $TEST_CHAT --text "$(at) B1 测试：告诉我当前工作目录" --as bot` | daemon 收到 inbound event | `journalctl -f` 有 `inbound event from ou_<bot>... chat=$TEST_CHAT thread=omt_...` |
| B2 | 表情确认 | daemon 在 gate `deliver` 后立刻给触发消息贴 `OnIt`（我在处理） | `journalctl -f` 无 `react(doing) failed`；`curl .../messages/<B1_id>/reactions` 返回一条 `emoji_type: OnIt` |
| B3 | Y-b spawn | `daemon: spawnFeishu session=... cwd=...` + 5 秒后 `injected feishu-spawn initial into tmux window fb:<prefix>` | `tmux list-windows -t claude-feishu` 多一个 `fb:<prefix>` 窗口 |
| B4 | threads.json 记录 | 新增 `origin:"feishu" status:"active"` 条目，绑定 B1 的 thread_id | `cat $STATE_DIR/threads.json` |
| B5 | Claude 回复 | 回复出现在 B1 开的话题里（不是新 root） | lark-cli `im +threads-messages-list --thread omt_<prefix>` 拿到消息列表 |
| B6 | 多轮 in-thread 路由 | `lark-cli im +messages-reply --message-id <B1 msg_id> --text "$(at) B6 再问：哪一年" --reply-in-thread --as bot` | 同一 session 处理；日志 `thread ... → session <同一个> → entry FOUND` + `send-keys inbound to claude-feishu:fb:<prefix>`；thread 再增一条 Claude 回复 |
| B7 | 关 thread 后礼貌拒绝 | `/feishu:access thread close <thread_id>` → 用 lark-cli 再回一条 | daemon 日志 `rec.status === "closed"` 分支 + 贴 `CrossMark` ❌ 表情 + 发 `thread closed — send a new top-level message` 文本 |

## 回归守门（可选但建议）

| # | 检查 | 命令 | 预期 |
|---|---|---|---|
| R1 | threads.json 里没有旧命名残留 | `grep -c '"X-b"\|"Y-b"' $STATE_DIR/threads.json` | `0`（开机迁移完成） |
| R2 | 代码里除了兼容层没残留 `X-b` / `Y-b` | `grep -rnE '\\bX-b\\b\|\\bY-b\\b' src/ tests/ \| grep -v migrate` | 空 |
| R3 | 没 zombie server.ts 占 WS | `pgrep -fa "server.ts"` | 空 |

## 通过定义

**本轮开发完成 = Pre-flight 全过 + 场景 A 全过 + 场景 B 全过**。

回归守门建议跑一次但不强制。R1 / R2 特别容易在重命名之后失败。

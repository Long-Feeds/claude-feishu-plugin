# Feishu 多会话 Bridge 开发全程

本文档汇总从 "飞书 plugin 只能绑定一个 session" 到生产可用的多会话 bridge 的完整开发过程。

---

## 起点

原实现：单文件 `server.ts`，一个 Claude session 绑一个飞书 chat。痛点：

- 多用户 / 多任务无法并行
- 会话挂了没法恢复
- 手动跑的 claude 和飞书完全没关系

## 目标

- **每个 Claude session ↔ 一个飞书 thread（话题）**
- **terminal**（旧名 X-b）：用户在终端手动起的 claude 自动挂到 bridge
- **feishu-spawn**（旧名 Y-b）：daemon 响应飞书来信自动 spawn 的 tmux 会话
- **resume**（旧名 L2）：挂掉的会话通过在 thread 里回复被复活（`claude --resume` fallback）
- **daemon**（旧名 D-b）：由 systemd user service 托管，独占 WSClient

## 最终架构

```
[Feishu WS 长连接] ──► daemon (systemd user service)
                       │
                       ├─► 路由决策 (gate + threads.json)
                       │
                       ├─► tmux new-window (feishu-spawn)
                       │     └─► claude --dangerously-skip-permissions
                       │           └─► bun shim ◄── .mcp.json 拉起
                       │                  │
                       └─► Unix socket ◄──┘  (MCP stdio ↔ socket)
```

| 组件 | 文件 | 说明 |
|---|---|---|
| daemon | `src/daemon.ts` | systemd 拉起，唯一 WSClient 持有者，Feishu API + routing + spawn |
| shim | `src/shim.ts` | 每个 Claude session 一个，MCP stdio ↔ daemon Unix socket 翻译层 |
| gate | `src/gate.ts` | 纯函数访问门控（allowlist / pairing / @mention） |
| threads | `src/threads.ts` | thread_id → session 绑定表，atomic write + corrupt 恢复 |
| access | `src/access.ts` | 凭证/白名单 JSON 读写 |
| spawn | `src/spawn.ts` | tmux new-window 命令组装，注 PATH 转发 |
| ipc | `src/ipc.ts` | NDJSON 协议 + 类型 |
| inbound | `src/inbound.ts` | 事件文本 + 附件抽取（post/card/image/file） |

状态目录：`~/.claude/channels/feishu/` — `.env`、`access.json`、`threads.json`、`inbox/`、`approved/`。

---

## 关键技术决策

| 维度 | 选型 | 理由 |
|---|---|---|
| 运行时 | Bun | 快启动 + TS native |
| 事件接收 | WSClient 长连接 | 同 APP_ID 只能有一个 WSClient，daemon 独占 |
| 路由 key | thread_id（话题群 Feishu 自动分）| p2p 无 thread（已知限制） |
| 会话注入 | tmux send-keys 字面量 + Enter | Claude Code welcome/idle 会吞 MCP notification |
| spawn 参数 | `--dangerously-skip-permissions` | 非交互环境，没人在 pane 前按 y/n |
| 状态持久化 | threads.json (atomic tmp+rename) | 重启后恢复绑定 |
| 存活保护 | systemd `KillMode=process` | 默认 control-group 会一起杀 tmux+claude |

---

## Commit 时间线

### 初期搭建（拆 server.ts → 多模块）

- ULID session_id、threads.json schema、gate/access 模块化
- 32 个单测基线：ipc / access / threads / gate / feishu-api / spawn / daemon-routing / integration

### 早期 bug 清零

| 症状 | 根因 | 修法 |
|---|---|---|
| 事件被旧进程吃 | 同 APP_ID 多 WSClient 只派发给一个 | 杀 `bun server.ts` 残留 + 独占 daemon |
| pairing code 丢失 | `gate()` 只改内存 pending | 调用后 `saveAccess` 持久化 |
| systemd 找不到 `claude` / `bun` | systemd user env PATH 过窄 | unit 里补 `~/.local/bin:~/.bun/bin` |
| WSClient 启动后被 GC | dispatcher 闭包在 nested 作用域 | 提到 `main()` + `setInterval` 保活 |
| 话题群 root @ 被丢 | root 消息已带 thread_id 但 daemon 当 unknown | 直接当 feishu-spawn 触发 + 预绑 thread |
| `msg_type: post` 的 initial prompt 为空 | 用了朴素 `JSON.parse(content).text` | 换 `extractTextAndAttachment` |
| welcome 屏吞 MCP notification | Claude 首启前 MCP 消息被丢 | 改用 `tmux send-keys -l` 字面量注入 |
| send-keys 后 Enter 没生效 | 和 text 合并时末尾 Enter 被吃 | 拆两次 send-keys，中间 300ms gap |
| 多轮第 2 轮起丢消息 | idle `❯` 同样吞 MCP notification | feishu-spawn 后续 inbound 也改走 send-keys（见 `rec.origin === "feishu"`） |
| threads.json 状态不准 | 没反映 shim disconnect | `onClose` markInactive + boot sweep active→inactive |

### 关键存活修复

- **`dc48db8`** — systemd 默认 `KillMode=control-group` 会把 daemon CGroup 下的 tmux server / claude / shim 全部 SIGTERM，`systemctl restart` 直接灭所有活会话。
  修复：`KillMode=process` 只杀 daemon 主进程；shim 加无限指数退避重连（上限 5s）；重连用**原来的** session_id 重注册，daemon 从 threads.json 恢复绑定。

### 本会话 4 次 robustness 加固

- **`db4f1ca`** — 三处鲁棒性：
  1. **Bot open_id** 原来走 `contact.user.get`，这个 API 要 `contact:user.*` scope，很多 bot 没开就 401，导致 `botOpenId=""`，`isMentioned()` 所有 @ 都 false，`requireMention=true` 的群静默丢消息。改用 `/bot/v3/info`（只要 tenant_access_token）+ `FEISHU_BOT_OPEN_ID` env 兜底。
  2. **`threads.json` TTL prune**：每次 feishu-spawn 留一行，从不清理。加 `pruneInactive()`，默认 30d（`FEISHU_THREADS_TTL_DAYS` 可调），boot 时跑一次。保留 active、closed、带 `claude_session_uuid` 的（resume 可恢复）。
  3. **`wrapForSendKeys()`** 抽出共用 helper：多行折叠为空格（避免 `\n` 被 tmux 当 Enter 截断 prompt）、`</channel>` → `</ channel>` 防标签闭合注入、属性值里的 `"` 转成 `&quot;`。两处调用点（handleRegister 初注入、deliverFeishuEvent 后续 inbound）都换成 helper。

- **`2ef9bdb`** — dev workflow papercut：daemon 实际跑的是 `~/.claude/plugins/cache/claude-feishu/feishu/0.0.1/` 的拷贝，不是 workspace。改完代码不 rsync 的话你会盯着旧代码的日志排查新代码的 bug。加 `bun sync` 一键 rsync + restart；CLAUDE.md 记录这个暗坑。

- **`0ec5934`** — resume revival 数据丢失 bug：`resumeSession` 把 Claude 重开了，但没设 `pendingFeishuInbound`，`handleRegister` 没东西往 pane 里 send-keys。复活出来的 Claude 盯着 idle prompt，不知道自己为什么被叫起来，用户回复的那条消息彻底蒸发。修：和 `spawnFeishu` 走同样的 staging 路径，把触发事件文本+meta 塞进 `pendingFeishuInbound[rec.session_id]`。加回归测试。

- **`1dc7838`** — feishu-spawn 附件 meta 丢失：`wrapForSendKeys` 只 emit 5 个核心 tag，但 `inboundMeta` 有 `image_path` / `attachment_kind` / `attachment_file_key` / `attachment_name`，shim 的 MCP instructions 告诉 Claude "If image_path, Read it. If attachment_file_key, call download_attachment"。丢了这些 tag 就是"你描述下这张图"→"我没看到图"。扩展 helper emit 这些字段，属性值引号转义 `"` → `&quot;`。同时给 eager image download 的 silent `catch {}` 加可见日志。

- **表情 ack（本轮新增）** — feishu-spawn 需要数秒才能冷启动 Claude，这段时间用户看不到任何信号，怀疑 bot 是否还活着。在 `deliverFeishuEvent` 里 gate 通过后对触发消息立刻贴一个"doing"表情（默认 `EYES`）作为快速非文字 ack；另外对 closed thread 回复再贴一个不同的"已封存"表情（默认 `LOCK`），和现有的 `thread closed — send a new top-level message` 文本回复一起出现。两者都走 fire-and-forget + `catch` 不阻断路由；表情名可通过 `FEISHU_REACT_DOING` / `FEISHU_REACT_CLOSED` 覆盖（空串 = 禁用）。drop / pair 路径不贴（drop 故意静默，pair 已有文字回应）。新增 3 条单测覆盖 deliver / drop / closed 三种路径。

- **terminal 自动 announce + hubChatId 自动补齐（本轮新增）** — 原有漏洞：终端起的 Claude 加载 feishu plugin 后 shim 向 daemon `register`，但 daemon 什么都不做，飞书侧毫无痕迹；而且 `handleReply` 首次回复对 terminal 走 hub chat 路径，如果 `access.hubChatId` 空（常见：用户纯在群里用，从未走 pair 流程）会直接报 "no Feishu hub chat configured — DM the bot first"，所以连 Claude 主动 reply 都发不出。修两处：(1) `deliverFeishuEvent` gate 通过且 `hubChatId` 未设时，自动把该 chat_id 写进 access.json 当 hub，避免静默死路；(2) `handleRegister` 对 `session_id === null` 的全新注册（即终端直起的 Claude，非 feishu-spawn 也非 reconnect）在 hub 已知时发一条 `🟢 Claude Code session online — cwd: <cwd>` 到 hub 并塞进 `pendingRoots`，让该 session 的首个 MCP reply 直接顺着这条 root 成 thread（不再另起一个 root）；hub 还没补齐时塞进 `deferredTerminalAnnounce` Map，首次 inbound auto-set hub 后立刻统一 flush。新增 3 条单测：auto-hubChatId、fresh-register announce、reconnect 不重复 announce。

- **WSClient 静默失连的 band-aid** — 本轮发现线上 daemon 在 `WebSocket connected` 后 12 小时内没有新事件到达，不是用户没发而是飞书端停止派发（常见触发：app_secret 旋转、app 被抢占、网络抖动）。这次直接靠 `bun sync` 重启 service 刷 WS。长期修法（未做）：daemon 加心跳 watchdog，N 分钟没事件就主动重连 WS。

---

## 端到端验证

| 场景 | 结果 |
|---|---|
| 单轮 @-mention（lark-cli 触发） | ✓ daemon 路由 + Claude 回复到原 thread |
| 多轮 in-thread（4 轮连续 @-reply） | ✓ 保持同一 session_id，逐轮响应 |
| 多行消息折叠 | ✓ 3 行 prompt 作为单 prompt 处理 |
| daemon 重启存活 | ✓ feishu-spawn 窗口 + shim + thread 绑定全保留，重启 ≤2s status 回 active |
| 4 次 commit 后回归 | ✓ 再发 @ 依然正确投递 |

## 测试增长

| 阶段 | 单测数 |
|---|---|
| 初期拆模块 | 32 |
| 本会话末 | 43 |
| 表情 ack 后 | 46 |
| terminal 自动 announce 后 | 49 |

本会话新增覆盖：gate 空 botOpenId 行为（3）、TTL prune 保留策略（1）、send-keys 编码多行/注入/附件/属性转义（5）、resume inbound 注入回归守卫（1）、表情 ack deliver/drop/closed 三路径（3）、auto-hubChatId/terminal fresh announce/reconnect 不重复（3）= 16 断言。

---

## 已知边界

- **DM 多轮**：p2p 无 thread_id，当前每条 DM spawn 新 feishu-spawn。修法：把 chat_id 当虚拟 thread key。**未实施**。
- **resume 不是真正的 state resume**：Claude Code 2.1 不暴露 session UUID 给 MCP child，resume 实际是"同 cwd 重开 + 用户回复作为 initial prompt"。shim 已有 forward-compat 钩子（读 `CLAUDE_SESSION_UUID` 等 env）。
- **单 cwd**：所有 feishu-spawn 用 `FEISHU_DEFAULT_CWD` 或 `~/workspace`，没实现按 chat / message 指定。
- **Permission 流 live 未验**：代码路径完整，端到端没跑通。
- **Attachment 下载 live 未验**：代码路径完整，没发真实图片测试过。

---

## 待办优化（Next candidates）

按影响 / 代价排序，未开工：

1. **feishu-spawn + resume resume 也做 eager image download**（小）：目前只有 in-thread inbound 路径提前下图并塞 `image_path` 进 send-keys；首轮触发 feishu-spawn 或 resume 复活的图片需要 Claude 手动调 `download_attachment`。抽成共享 helper，三路径统一。
2. **DM 多轮 via chat_id 虚拟 thread**（中大）：p2p 无 thread_id，每条 DM 新 spawn 是最大 UX gap。把 chat_id 当虚拟 thread key，改 gate + threads + deliverFeishuEvent。
3. **首次 reply 后贴"done"表情**（小）：补全生命周期 EYES → OK。需要 `pendingTriggerAck: Map<session_id, message_id>`，首次 reply 消费 + 贴 OK。单独价值不大——reply 本身就是"done"信号。
4. **Per-chat / per-message 指定 cwd**（中）：目前所有 feishu-spawn 用 `FEISHU_DEFAULT_CWD`。可以按 chat_id 在 access.json 里配，或让消息里带指令（如 `/cwd /path`）。
5. ~~**terminal 自动 announce**~~ ✅ 已完成（见上文"terminal 自动 announce + hubChatId 自动补齐"）。
6. **WS staleness watchdog**：daemon 心跳监控 + N 分钟无事件主动 reconnect WSClient，替代目前手动 `bun sync` 重启。

---

## 目录结构

```
.claude-plugin/plugin.json          插件元数据
.mcp.json                           拉起 shim（bun run shim）
package.json                        scripts: daemon / shim / start / test / sync
server.ts                           旧单文件实现，rollback 保留
src/
  daemon.ts                         systemd 拉起的主进程
  shim.ts                           Claude 加载的 MCP server
  ipc.ts                            NDJSON 协议 + 类型
  access.ts                         access.json 读写
  threads.ts                        threads.json + 状态机 + pruneInactive
  feishu-api.ts                     Feishu API 封装
  spawn.ts                          tmux new-window 包装
  daemon-state.ts                   daemon 内存 session 注册表
  gate.ts                           纯函数访问门控
  inbound.ts                        Feishu event 文本 + 附件抽取
tests/
  smoke.test.ts ipc.test.ts access.test.ts threads.test.ts
  feishu-api.test.ts spawn.test.ts gate.test.ts
  daemon-routing.test.ts wrap-sendkeys.test.ts
  integration/fake-daemon.ts integration/shim.test.ts
systemd/
  claude-feishu.service.tmpl        /feishu:configure install-service 渲染
skills/
  configure/SKILL.md                `/feishu:configure`
  access/SKILL.md                   `/feishu:access`
docs/
  smoke.md                          人肉 + lark-cli 自动化测试清单
  superpowers/specs/                设计文档
  superpowers/plans/                21-task 实施计划
```

## 部署 / 开发流程

```bash
# 首次部署
/feishu:configure install-service
systemctl --user status claude-feishu
journalctl --user -u claude-feishu -f

# dev 迭代
bun test                            # 43 单测
bun sync                            # rsync workspace → plugin cache + restart
journalctl --user -u claude-feishu -f

# 运维
cat ~/.claude/channels/feishu/access.json
cat ~/.claude/channels/feishu/threads.json
/feishu:access threads              # 按状态分组展示
/feishu:access thread close <id>    # 归档
/feishu:access thread kill <id>     # 杀 tmux window
```

## 飞书应用配置要点

1. 飞书开放平台创建自建应用（open.feishu.cn）
2. 启用 Bot 能力
3. 事件订阅设置为「使用长连接接收事件」
4. 订阅 `im.message.receive_v1`
5. 权限：`im:message`、`im:message:send_as_bot`、`im:resource`
6. 发布版本并由管理员审批

# Codex 飞书桥接规格

## Summary

`codex-feishu-bridge` 是一个独立的本机 Node.js 服务：监听飞书机器人消息，调用本机 `codex exec --json` 执行任务，并把 Codex 最终结果发回飞书。

当前版本支持：

- 文本对话：Lark/飞书消息 -> Codex -> 飞书文本回复。
- 图片回传：Lark/飞书生图指令 -> Codex 生成或准备本地图片文件 -> 桥接上传图片 -> 飞书图片回复。

默认不做语音/视频、不做 Claude、不做多 agent。

默认行为：

- 私聊机器人：任意文本触发 Codex。
- 群聊：只有 `@机器人` 的消息触发 Codex。
- 每个 chat 维护一个 Codex session，支持连续对话。
- `/new` 清空当前 chat 的 Codex session。
- `/status` 查看运行状态。
- 进程前台常驻运行。

## Configuration

配置全部来自环境变量：

- `FEISHU_APP_ID`：飞书 App ID。
- `FEISHU_APP_SECRET`：飞书 App Secret，禁止提交到 git。
- `FEISHU_DOMAIN=feishu`：国内飞书；如 Lark 国际版改为 `lark`。
- `CODEX_WORKDIR=/Users/tangsijie/Documents/agenttest`：Codex 工作目录。
- `CODEX_SANDBOX=workspace-write`：默认允许写当前工作区。
- `CODEX_MODEL`：可选，不设置则用 Codex 默认模型。
- `REQUIRE_MENTION_IN_GROUP=true`：群聊必须 @ 机器人。
- `CODEX_TIMEOUT_MS=900000`：普通文本任务最长 15 分钟。
- `IMAGE_OUTPUT_DIR=generated`：图片产物目录；相对路径按桥接项目根目录解析。
- `IMAGE_TIMEOUT_MS=900000`：图片任务最长 15 分钟。
- `IMAGE_MAX_BYTES=10485760`：飞书消息图片最大 10MB。
- `OPENAI_API_KEY`：默认不需要。仅当未来切到桥接服务直接调用 OpenAI Images API 时才需要。
- `IMAGE_MODEL=gpt-image-2`：预留给未来 OpenAI API 模式；当前默认 Codex 直连模式不直接读取该变量。

## Runtime Behavior

飞书消息处理：

- 忽略空消息、机器人自己发出的消息、群聊未 @ 的消息。
- `/new`：中断当前 chat 的运行任务，删除当前 chat 的 session，并回复确认。
- `/status`：返回 workdir、Codex CLI 版本、当前 session id、运行中状态、图片输出目录。
- 普通文本：回复“Codex 执行中”，然后排队执行。
- 生图文本：回复“Codex 正在生成图片”，然后排队执行。
- 同一 chat 串行执行，避免多个 Codex session 同时写同一项目。
- Codex 失败、超时或退出码非 0 时，把错误摘要回传飞书。

生图触发方式：

- `/image <prompt>`
- `/img <prompt>`
- `/draw <prompt>`
- `生图 <prompt>`
- `画图 <prompt>`
- `画一张 <prompt>`
- `生成图片 <prompt>`
- `生成一张图 <prompt>`

## Codex Text Flow

首次对话执行：

```bash
codex exec --json --cd <CODEX_WORKDIR> --sandbox <CODEX_SANDBOX> --skip-git-repo-check -
```

后续对话执行：

```bash
codex exec resume --json --skip-git-repo-check <sessionId> -
```

prompt 通过 stdin 传入，避免命令行长度问题。

从 JSONL 中读取：

- `thread.started.thread_id` 保存 session id。
- `item.completed` 且 `item.type === "agent_message"` 作为最终回复候选。
- `turn.completed` 作为正常结束信号。

文本任务只回传最终 assistant 文本；不做流式更新和工具过程卡片。

## Codex Image Flow

默认图片模式不直接调用 OpenAI API，也不要求 `OPENAI_API_KEY`。

流程：

1. 桥接识别生图指令。
2. 桥接把用户原始需求包装成 Codex 图片任务 prompt。
3. Codex 在 `IMAGE_OUTPUT_DIR` 下生成或准备一个真实图片文件。
4. Codex 最终回复中输出 `IMAGE_PATH: <absolute-or-workdir-relative-path>`。
5. 桥接验证图片存在、类型合法、大小不超过 `IMAGE_MAX_BYTES`。
6. 桥接通过飞书图片接口上传图片。
7. 桥接回复原消息一条图片消息，并追加一条带 Codex session 的简短文本说明。

支持图片格式：

- `.png`
- `.jpg`
- `.jpeg`
- `.webp`
- `.gif`

如果 Codex 环境本身能调用可用的图像生成工具或模型，它可以在图片任务中使用；如果不能，它可以用本地脚本或其他可用方式生成图片文件。桥接只负责调度 Codex、识别图片文件、上传飞书，不伪造 `gpt-image-2` 调用结果。

如果目标是“桥接服务直接调用 OpenAI Images API 的 `gpt-image-2`”，则需要后续新增 OpenAI API 模式，并配置 `OPENAI_API_KEY`。Codex CLI 登录态不能当作 OpenAI API Key 使用。

## Feishu App Requirements

飞书开放平台中需要确认：

- 应用已启用机器人能力。
- 机器人可接收消息事件。
- 机器人可发送消息。
- 机器人拥有上传图片资源权限：`im:resource`。
- 如果在群聊使用，机器人必须被加入群，且群消息默认需要 @。
- 当前版本不读取用户上传的附件，所以暂不要求图片/文件下载权限。

## Test Plan

本机命令验证：

- `node --version` >= 20。
- `codex --version` 可用。
- `codex exec --json --skip-git-repo-check "Reply with exactly: ok"` 能返回 JSONL。
- `npm install` 成功。
- `npm run check` 成功。
- `npm start` 能连接飞书并打印 bot 身份。

飞书文本验证：

- 私聊发送 `你好`，机器人回复 Codex 结果。
- 连续私聊第二句，确认沿用同一 session。
- 发送 `/new` 后再问，确认新建 session。
- 发送 `/status`，确认显示 workdir、session、Codex 版本、图片输出目录。
- 群聊未 @ 不回复，@ 后回复。
- 临时断开/错误时，飞书收到可读错误摘要。

飞书图片验证：

- 私聊发送 `/image 生成一张简单的红色圆形图标`，机器人回复图片。
- 连续发送第二个图片需求，确认同一 chat 串行执行。
- 发送 `画一张 ...`，确认中文触发词可用。
- 如果缺少 `im:resource`，应收到可读的图片上传失败摘要。
- 如果 Codex 没有生成图片文件，应返回 Codex 文本结果和“未找到图片文件”的说明。

## Safety

- App Secret 只通过环境变量传入，不写进仓库文件。
- `.env` 和 `.env.local` 在根 `.gitignore` 中排除。
- 生成图片目录 `generated/` 在根 `.gitignore` 中排除。
- 默认 sandbox 为 `workspace-write`，不启用 `dangerously-bypass-approvals-and-sandbox`。
- 图片上传前做路径、扩展名和大小校验。
- 飞书侧建议只给可信用户/群使用机器人。

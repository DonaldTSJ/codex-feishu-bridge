# Codex Feishu Bridge

把飞书 / Lark 机器人消息桥接到本机 Codex CLI：你在飞书里输入指令，服务调用 `codex exec --json` 执行任务，再把最终结果回复回飞书。

当前版本是一个最小可运行的本机 Node.js 服务，适合个人或可信群使用。

## Features

- 私聊机器人：任意文本触发 Codex。
- 群聊：默认只有 `@机器人` 的消息触发 Codex。
- 每个 chat 维护一个 Codex session，支持连续对话。
- `/new` 清空当前 chat 的 Codex session。
- `/status` 查看运行状态。
- 文本任务：飞书文本 -> Codex -> 飞书 Markdown 回复。
- 图片任务：飞书生图指令 -> Codex 生成本地图片 -> 桥接上传图片 -> 飞书图片回复。
- 同一 chat 串行执行，避免多个任务同时写同一工作目录。

## Image Mode

默认图片模式不直接调用 OpenAI Images API，也不要求 `OPENAI_API_KEY`。

桥接服务会把生图需求交给 Codex，要求 Codex 在本机生成或准备一个图片文件，并在最终回复中输出：

```text
IMAGE_PATH: /absolute/path/to/image.png
```

然后桥接服务验证图片路径、格式和大小，并用飞书机器人身份上传图片。

支持触发词：

```text
/image 生成一张简单的红色圆形图标
/img 赛博朋克风格的蓝色机器人头像
/draw 低多边形风格的城市夜景
生图 一张极简海报
画图 一只机器人猫
画一张 产品发布会封面图
生成图片 一张社交媒体配图
生成一张图 一张知识卡片
```

如果你想让桥接服务直接调用 OpenAI Images API 的 `gpt-image-2`，需要另外实现 OpenAI API 模式并配置 `OPENAI_API_KEY`。Codex CLI 登录态不能当作 OpenAI API Key 使用。

## Requirements

- Node.js >= 20
- 已安装并登录可用的 Codex CLI
- 飞书 / Lark 自建应用
- 应用已启用机器人能力
- 应用已启用长连接接收消息事件
- 机器人具备发送消息能力
- 图片回传需要飞书权限 `im:resource`

## Feishu App Setup

在飞书开放平台确认：

- 应用类型是自建应用。
- 已启用机器人能力。
- 事件订阅方式使用长连接。
- 已订阅机器人接收消息事件。
- 机器人可以发送消息。
- 如果要回传图片，开通 `im:resource` 权限。
- 如果在群聊使用，把机器人加入群；群聊默认需要 @ 机器人。

## Install

```bash
npm install
```

复制配置模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=replace_with_your_secret
FEISHU_DOMAIN=feishu

CODEX_WORKDIR=/Users/tangsijie/Documents/agenttest
CODEX_SANDBOX=workspace-write
CODEX_TIMEOUT_MS=900000

IMAGE_OUTPUT_DIR=generated
IMAGE_TIMEOUT_MS=900000
IMAGE_MAX_BYTES=10485760

REQUIRE_MENTION_IN_GROUP=true
```

不要提交 `.env`、App Secret、access token 或任何真实密钥。

## Run

前台运行：

```bash
npm run start:env
```

也可以直接用环境变量运行：

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm start
```

启动后看到类似输出表示连接成功：

```text
Codex Feishu bridge connected. bot=... workdir=... codex=codex-cli ...
Listening for Feishu/Lark messages. Press Ctrl+C to exit.
```

## Commands

```text
/status
```

查看当前工作目录、Codex 版本、session、队列、图片目录等状态。

```text
/new
```

中断当前 chat 的运行任务并清空当前 chat 的 Codex session。

```text
/image <prompt>
```

让 Codex 生成或准备一张本地图片，再由桥接服务上传回飞书。

## Test

本机检查：

```bash
node --version
codex --version
codex exec --json --skip-git-repo-check "Reply with exactly: ok"
npm run check
```

飞书检查：

- 私聊机器人发送 `你好`，确认收到 Codex 回复。
- 连续发送第二句，确认沿用同一 session。
- 发送 `/status`，确认状态正常。
- 发送 `/new`，确认 session 被清空。
- 发送 `/image 生成一张简单的红色圆形图标`，确认收到图片。
- 群聊中未 @ 不回复，@ 后回复。

## Project Structure

```text
.
├── src/
│   ├── index.js      # 飞书连接、消息处理、队列、回传
│   ├── codex.js      # Codex CLI 调用和 JSONL 解析
│   ├── image.js      # 生图命令识别、图片任务 prompt、图片路径校验
│   └── sessions.js   # chat -> Codex session 持久化
├── SPEC.md           # 规格文档
├── tutorial.html     # 本地教程页
├── launch-wrapper.sh # 本机启动包装脚本
└── .env.example      # 配置模板
```

## Safety Notes

- 默认 sandbox 是 `workspace-write`。
- 不启用 `dangerously-bypass-approvals-and-sandbox`。
- App Secret 只通过环境变量或 `.env` 传入。
- `.env`、日志、pid、`generated/`、`node_modules/` 都已加入 `.gitignore`。
- 建议只把机器人开放给可信用户或可信群。

## Troubleshooting

服务无响应：

```bash
tail -f bridge.log
```

检查是否连接成功、是否收到消息事件、是否有 Codex 运行错误。

图片上传失败：

- 确认飞书应用已开通 `im:resource`。
- 确认生成图片小于 `IMAGE_MAX_BYTES`，默认 10 MB。
- 确认图片格式是 `.png`、`.jpg`、`.jpeg`、`.webp` 或 `.gif`。

Codex 没有结束：

- 当前实现会在收到 `turn.completed` 后短暂等待并结束子进程。
- 如果任务很长，调大 `CODEX_TIMEOUT_MS` 或 `IMAGE_TIMEOUT_MS`。

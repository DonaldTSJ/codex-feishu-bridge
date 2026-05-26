#!/bin/zsh
set -u

cd /Users/tangsijie/Documents/agenttest/codex-feishu-bridge

export PATH="/Applications/Codex.app/Contents/Resources:/Users/tangsijie/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export FEISHU_APP_ID="${FEISHU_APP_ID:-$(launchctl getenv FEISHU_APP_ID)}"
export FEISHU_APP_SECRET="${FEISHU_APP_SECRET:-$(launchctl getenv FEISHU_APP_SECRET)}"
export FEISHU_DOMAIN="${FEISHU_DOMAIN:-feishu}"
export CODEX_WORKDIR="${CODEX_WORKDIR:-/Users/tangsijie/Documents/agenttest}"
export CODEX_SANDBOX="${CODEX_SANDBOX:-workspace-write}"
export CODEX_TIMEOUT_MS="${CODEX_TIMEOUT_MS:-900000}"
export IMAGE_OUTPUT_DIR="${IMAGE_OUTPUT_DIR:-generated}"
export IMAGE_TIMEOUT_MS="${IMAGE_TIMEOUT_MS:-900000}"
export IMAGE_MAX_BYTES="${IMAGE_MAX_BYTES:-10485760}"
export REQUIRE_MENTION_IN_GROUP="${REQUIRE_MENTION_IN_GROUP:-true}"

echo "[launch-wrapper] starting node at $(date -Iseconds); app_id_set=$([[ -n \"$FEISHU_APP_ID\" ]] && echo yes || echo no); secret_set=$([[ -n \"$FEISHU_APP_SECRET\" ]] && echo yes || echo no)"

echo "$$" > /Users/tangsijie/Documents/agenttest/codex-feishu-bridge/bridge.pid
exec /usr/local/bin/node /Users/tangsijie/Documents/agenttest/codex-feishu-bridge/src/index.js

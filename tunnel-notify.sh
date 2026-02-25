#!/bin/bash

# Cloudflare Tunnel 包装脚本
# 启动 cloudflared 并实时监听 URL 变化，立即发送 Telegram 通知

TELEGRAM_BOT_TOKEN="8405186727:AAE-iYAD16cepFoITGG8ORReznv9ngKgIns"
TELEGRAM_CHAT_ID="8562069932"
LAST_URL_FILE="/tmp/ccm-tunnel-last-url"

send_telegram() {
    local url="$1"
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=🌐 *CCManager 公网地址*

${url}

⏰ $(date '+%Y-%m-%d %H:%M:%S')" \
        -d "parse_mode=Markdown" > /dev/null 2>&1
    echo "[$(date)] Telegram sent: $url"
}

# 启动 cloudflared，stderr 通过管道实时处理
# cloudflared 的 URL 输出在 stderr
exec 2>&1
cloudflared tunnel --url http://localhost:3001 2>&1 | while IFS= read -r line; do
    echo "$line"

    # 检测 URL
    if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
        URL="${BASH_REMATCH[1]}"

        # 检查是否是新 URL
        LAST_URL=""
        [ -f "$LAST_URL_FILE" ] && LAST_URL=$(cat "$LAST_URL_FILE" 2>/dev/null)

        if [ "$URL" != "$LAST_URL" ]; then
            echo "$URL" > "$LAST_URL_FILE"
            send_telegram "$URL"
        fi
    fi
done

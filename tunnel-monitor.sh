#!/bin/bash

# Cloudflare Tunnel URL 监控脚本
# 检测 URL 变化并发送 Telegram 通知

TUNNEL_LOG="/tmp/ccm-tunnel.log"
LAST_URL_FILE="/tmp/ccm-tunnel-last-url"
TELEGRAM_BOT_TOKEN="8405186727:AAE-iYAD16cepFoITGG8ORReznv9ngKgIns"
TELEGRAM_CHAT_ID="8562069932"
CHECK_INTERVAL=10  # 检查间隔（秒）

send_telegram() {
    local message="$1"
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=${message}" \
        -d "parse_mode=Markdown" > /dev/null
}

get_tunnel_url() {
    if [ -f "$TUNNEL_LOG" ]; then
        grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null | tail -1
    fi
}

echo "Starting tunnel URL monitor..."

# 初始化上次 URL
LAST_URL=""
if [ -f "$LAST_URL_FILE" ]; then
    LAST_URL=$(cat "$LAST_URL_FILE")
fi

while true; do
    CURRENT_URL=$(get_tunnel_url)

    if [ -n "$CURRENT_URL" ] && [ "$CURRENT_URL" != "$LAST_URL" ]; then
        echo "$(date): URL changed: $CURRENT_URL"

        # 保存新 URL
        echo "$CURRENT_URL" > "$LAST_URL_FILE"
        LAST_URL="$CURRENT_URL"

        # 发送 Telegram 通知
        send_telegram "🌐 *CCManager 公网地址更新*

$CURRENT_URL

⏰ $(date '+%Y-%m-%d %H:%M:%S')"

        echo "Telegram notification sent!"
    fi

    sleep $CHECK_INTERVAL
done

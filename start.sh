#!/bin/bash

# CCManager 启动脚本 (使用 pm2 守护进程)
# Telegram 通知由 tunnel-monitor.sh 自动处理

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 清除旧的 URL 记录，确保新启动时发送通知
rm -f /tmp/ccm-tunnel-last-url

# 停止旧进程
echo "Stopping existing services..."
npx pm2 delete all 2>/dev/null
sleep 1

# 清空旧日志
> /tmp/ccm-tunnel.log 2>/dev/null

# 启动所有服务
echo "Starting services with pm2..."
npx pm2 start ecosystem.config.cjs
sleep 3

# 等待获取隧道 URL
echo "Waiting for tunnel URL..."
for i in {1..30}; do
    TUNNEL_URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /tmp/ccm-tunnel.log 2>/dev/null | tail -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 1
done

echo ""
echo "=== CCManager Running ==="
echo "Server: http://localhost:3001"
if [ -n "$TUNNEL_URL" ]; then
    echo "Tunnel: $TUNNEL_URL"
    echo "(Telegram notification will be sent by tunnel-monitor)"
else
    echo "Tunnel: (waiting for URL...)"
fi
echo ""
echo "Commands:"
echo "  Status:  npx pm2 status"
echo "  Logs:    npx pm2 logs"
echo "  Stop:    npx pm2 stop all"
echo "  Restart: npx pm2 restart all"
echo ""

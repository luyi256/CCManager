#!/bin/bash

# CCManager startup script (uses pm2 for process management)
# Telegram notifications handled by tunnel-notify.sh (integrated into pm2)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Clear old URL record to ensure notification on fresh start
rm -f /tmp/ccm-tunnel-last-url

# Stop existing processes
echo "Stopping existing services..."
npx pm2 delete all 2>/dev/null
sleep 1

# Clear old logs
> /tmp/ccm-tunnel.log 2>/dev/null

# Start all services (including ccm-agent and ccm-tunnel)
echo "Starting services with pm2..."
npx pm2 start ecosystem.config.cjs
sleep 3

# Wait for tunnel URL
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
    echo "(Telegram notification sent automatically)"
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

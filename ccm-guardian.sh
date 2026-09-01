#!/usr/bin/env bash
# CCManager Agent 守护脚本
# 检测 ccm-agent 进程状态 + 远程连接状态，异常时自动重启
# 支持：一次性检查 / 持续守护 / 状态查看
set -euo pipefail

# ── 配置 ──────────────────────────────────────────────────
CCM_DIR="/home/luyi/CCManager"
AGENT_CONFIG="/home/luyi/.ccm-agent.json"
AGENT_LOG="/tmp/ccm-agent.log"
HEARTBEAT_FILE="/tmp/ccm-agent-heartbeat.json"
HEALTH_TIMEOUT=5
AGENT_CHECK_WINDOW=120
FAILURE_THRESHOLD=3
RESTART_COOLDOWN=600
STATE_FILE="/tmp/ccm-guardian.state"
LOCK_FILE="/tmp/ccm-guardian.lock"
PNPM_CJS="/usr/local/lib/nodejs/node-v22.23.1-linux-x64/lib/node_modules/pnpm/bin/pnpm.cjs"
PATH="/usr/local/bin:$PATH"

# ── 颜色 ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $(date '+%Y-%m-%d %H:%M:%S')  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $(date '+%Y-%m-%d %H:%M:%S')  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $(date '+%Y-%m-%d %H:%M:%S')  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S')  $*"; }

# ── PM2 封装 ──────────────────────────────────────────────
pm2_cmd() {
    cd "$CCM_DIR" && $PNPM_CJS exec pm2 "$@"
}

# ── 1. 检查 agent 进程是否存在且 online ───────────────────
check_agent_process() {
    if pm2_cmd jlist 2>/dev/null | \
       python3 -c "
import sys, json
apps = json.load(sys.stdin)
app = next((a for a in apps if a['name'] == 'ccm-agent'), None)
sys.exit(0 if app and app.get('pm2_env', {}).get('status') == 'online' else 1)
" 2>/dev/null; then
        return 0
    fi
    return 1
}

# ── 2. 检查 agent 日志中的远程连接状态 ─────────────────────
check_agent_connection() {
    if [ -f "$HEARTBEAT_FILE" ]; then
        local heartbeat_age heartbeat_connected
        heartbeat_age=$(( $(date +%s) - $(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0) ))
        heartbeat_connected=$(python3 -c "
import json
try:
    print('1' if json.load(open('$HEARTBEAT_FILE')).get('connected') else '0')
except Exception:
    print('0')
" 2>/dev/null)
        if [ "$heartbeat_connected" = "1" ] && [ "$heartbeat_age" -le "$AGENT_CHECK_WINDOW" ]; then
            return 0
        fi
        return 1
    fi

    # Upgrade fallback for an older agent that has not emitted its heartbeat
    # file yet. Scan lifecycle events, never an arbitrary log tail.
    if [ ! -f "$AGENT_LOG" ]; then
        return 1
    fi

    local last_registered last_disconnected last_error
    # Inspect lifecycle events across the log. A fixed `tail -n 40` window is
    # unsafe because ordinary task/session logs can push a valid registration
    # out of the window and make a healthy agent look disconnected.
    last_registered=$(grep -n "Registered as:" "$AGENT_LOG" 2>/dev/null | tail -1 | cut -d: -f1 || true)
    last_disconnected=$(grep -n "Disconnected from manager" "$AGENT_LOG" 2>/dev/null | tail -1 | cut -d: -f1 || true)
    last_error=$(grep -n "Connection error" "$AGENT_LOG" 2>/dev/null | tail -1 | cut -d: -f1 || true)
    last_registered=${last_registered:-0}
    last_disconnected=${last_disconnected:-0}
    last_error=${last_error:-0}

    if [ "$last_registered" -gt "$last_disconnected" ] && \
       [ "$last_registered" -gt "$last_error" ] && \
       [ "$last_registered" -gt 0 ]; then
        return 0
    fi
    return 1
}

# ── 3. 检查远程 server-url.txt 中的 server 是否可达 ────────
check_remote_server() {
    local server_url
    if [ -f "$AGENT_CONFIG" ]; then
        local data_path
        data_path=$(python3 -c "import json; print(json.load(open('$AGENT_CONFIG'))['dataPath'])" 2>/dev/null || echo "")
        if [ -n "$data_path" ] && [ -f "$data_path/server-url.txt" ]; then
            server_url=$(cat "$data_path/server-url.txt" | tr -d '[:space:]')
        fi
    fi

    if [ -z "${server_url:-}" ]; then
        # 无法获取 server URL，跳过检查
        return 0
    fi

    local resp
    resp=$(python3 - "$server_url" "$HEALTH_TIMEOUT" <<'PY' 2>/dev/null || echo "000"
import sys
import urllib.request

url = sys.argv[1].rstrip("/") + "/api/health"
timeout = float(sys.argv[2])
try:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        print(response.status)
except Exception:
    print("000")
PY
)
    if [ "$resp" = "200" ]; then
        return 0
    fi
    return 1
}

# ── 4. 重启 agent ─────────────────────────────────────────
restart_agent() {
    warn "正在重启 ccm-agent ..."
    pm2_cmd restart ccm-agent 2>&1 || {
        error "重启失败，尝试重新启动..."
        pm2_cmd start "$CCM_DIR/ecosystem.config.cjs" 2>&1
    }
    sleep 5
    if check_agent_process; then
        ok "ccm-agent 进程已恢复"
        return 0
    else
        error "ccm-agent 进程仍异常"
        return 1
    fi
}

read_state() {
    CONSECUTIVE_FAILURES=0
    LAST_RESTART_AT=0
    if [ -f "$STATE_FILE" ]; then
        # shellcheck disable=SC1090
        source "$STATE_FILE" 2>/dev/null || true
    fi
    CONSECUTIVE_FAILURES=${CONSECUTIVE_FAILURES:-0}
    LAST_RESTART_AT=${LAST_RESTART_AT:-0}
}

write_state() {
    cat > "$STATE_FILE" <<EOF
CONSECUTIVE_FAILURES=$CONSECUTIVE_FAILURES
LAST_RESTART_AT=$LAST_RESTART_AT
EOF
}

record_success() {
    CONSECUTIVE_FAILURES=0
    write_state
}

record_failure() {
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    write_state
}

# ── 5. 完整重建（git pull + 重编译 + 重启）────────────────
full_rebuild() {
    error "多次重启失败，执行完整重建..."

    warn "拉取最新代码..."
    cd "$CCM_DIR" && git pull --ff-only 2>&1 || warn "git pull 失败（继续）"

    warn "重新编译 agent ..."
    cd "$CCM_DIR" && $PNPM_CJS --filter @ccmanager/agent build 2>&1 || {
        error "编译失败"
        return 1
    }

    warn "重新启动..."
    pm2_cmd delete ccm-agent 2>/dev/null || true
    sleep 2
    pm2_cmd start "$CCM_DIR/ecosystem.config.cjs" 2>&1
    pm2_cmd save 2>/dev/null
    sleep 5

    if check_agent_process; then
        ok "完整重建完成"
        return 0
    else
        error "完整重建后仍异常，需要手动介入"
        return 1
    fi
}

# ── 主检测逻辑 ────────────────────────────────────────────
check_once() {
    local changed=false
    local agent_ok=false
    read_state

    if check_agent_process; then
        if check_agent_connection; then
            ok "ccm-agent 运行正常 — 已连接到远程 server"
            agent_ok=true
            record_success
        else
            record_failure
            warn "ccm-agent 连接检查失败（连续 ${CONSECUTIVE_FAILURES}/${FAILURE_THRESHOLD} 次）"
            if ! check_remote_server; then
                warn "远程 server 健康检查也失败，本轮不重启 Agent，等待网络恢复"
            elif [ "$CONSECUTIVE_FAILURES" -lt "$FAILURE_THRESHOLD" ]; then
                warn "尚未达到重启阈值，本轮仅告警"
            else
                local now
                now=$(date +%s)
                if [ $((now - LAST_RESTART_AT)) -lt "$RESTART_COOLDOWN" ]; then
                    warn "仍处于 ${RESTART_COOLDOWN}s 重启冷却期，本轮仅告警"
                else
                    changed=true
                    if restart_agent; then
                        agent_ok=true
                        LAST_RESTART_AT=$now
                        CONSECUTIVE_FAILURES=0
                        write_state
                    fi
                fi
            fi
        fi
    else
        record_failure
        warn "ccm-agent 进程不存在或已停止（连续 ${CONSECUTIVE_FAILURES}/${FAILURE_THRESHOLD} 次）"
        if [ "$CONSECUTIVE_FAILURES" -ge "$FAILURE_THRESHOLD" ]; then
            changed=true
            if restart_agent; then
                agent_ok=true
                LAST_RESTART_AT=$(date +%s)
                CONSECUTIVE_FAILURES=0
                write_state
            fi
        fi
    fi

    # 如果重启后仍异常，执行完整重建
    if $changed && ! $agent_ok && [ "$CONSECUTIVE_FAILURES" -ge $((FAILURE_THRESHOLD * 2)) ]; then
        full_rebuild
        LAST_RESTART_AT=$(date +%s)
        CONSECUTIVE_FAILURES=0
        write_state
        changed=true
    fi

    if $changed; then
        echo ""
        info "本轮检测后 PM2 状态："
        pm2_cmd status 2>/dev/null || true
    fi

    return 0
}

# ── 守护模式 ──────────────────────────────────────────────
run_daemon() {
    local interval="${1:-60}"
    info "ccm-agent 守护模式已启动，检测间隔: ${interval} 秒"
    info "按 Ctrl+C 停止"
    echo ""

    while true; do
        check_once
        echo ""
        sleep "$interval"
    done
}

# ── 帮助 ──────────────────────────────────────────────────
usage() {
    cat <<EOF
用法: $(basename "$0") [模式]

模式:
  (无参数)             执行一次全面检测，仅报告和重启异常服务
  daemon [间隔秒数]    持续守护模式，每隔 N 秒检测一次（默认 60 秒）
  status               仅显示当前状态（不修复）
  help                 显示此帮助

检测项目:
  - ccm-agent PM2 进程是否 online
  - ccm-agent 日志中是否保持远程连接
  - 远程 server (server-url.txt) 是否可达

自愈策略:
  1. 进程异常 → 重启 agent
  2. 连接断开 → 重启 agent
  3. 多次重启失败 → 完整重建（git pull + 编译 + 重启）

示例:
  $(basename "$0")              # 检查一次
  $(basename "$0") daemon 30    # 每 30 秒守护一次
  $(basename "$0") status       # 只看状态

配合 crontab（以 luyi 用户）:
  */2 * * * * /home/luyi/CCManager/ccm-guardian.sh >> /tmp/ccm-guardian.log 2>&1
EOF
}

# ── 状态 ──────────────────────────────────────────────────
show_status() {
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════${NC}"
    echo -e "${CYAN}   CCManager Agent 状态${NC}"
    echo -e "${CYAN}════════════════════════════════════════════${NC}"
    echo ""

    echo -n "  ccm-agent 进程:    "
    if check_agent_process; then
        echo -e "${GREEN}在线${NC}"
    else
        echo -e "${RED}离线${NC}"
    fi

    echo -n "  远程连接状态:      "
    if check_agent_connection; then
        echo -e "${GREEN}已连接${NC}"
    else
        echo -e "${RED}断开${NC}"
    fi

    echo -n "  远程 server 可达:  "
    if check_remote_server; then
        echo -e "${GREEN}可达${NC}"
    else
        echo -e "${RED}不可达${NC}"
    fi

    echo ""
    echo "PM2 进程列表:"
    pm2_cmd status 2>/dev/null || echo "  (无法获取 PM2 状态)"
    echo ""
}

# ── Entry ──────────────────────────────────────────────────
MODE="${1:-check}"

# Prevent overlapping cron/manual checks from racing and issuing duplicate
# restarts. `flock` is provided by util-linux on supported deployment hosts.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        warn "已有 guardian 检查正在运行，本轮跳过"
        exit 0
    fi
fi

case "$MODE" in
    check|"")
        check_once
        ;;
    daemon)
        run_daemon "${2:-60}"
        ;;
    status)
        show_status
        ;;
    help|-h|--help)
        usage
        ;;
    *)
        echo "未知模式: $MODE"
        usage
        exit 1
        ;;
esac

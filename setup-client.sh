#!/usr/bin/env bash
# CCManager Agent (Client) - One-click setup & run script
# Usage: bash setup-client.sh [--reconfigure]
set -euo pipefail

RECONFIGURE=false
for arg in "$@"; do
  case "$arg" in
    --reconfigure) RECONFIGURE=true ;;
  esac
done

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo -e "${CYAN}   CCManager Agent (Client) Setup${NC}"
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo

# ── 1. Check prerequisites ─────────────────────────────
info "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  err "Node.js not found. Please install Node.js >= 18."
  err "  → https://nodejs.org/ or: curl -fsSL https://fnm.vercel.app/install | bash"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  err "Node.js >= 18 required, found $(node -v)"
  exit 1
fi
ok "Node.js $(node -v)"

# pnpm
if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found, installing..."
  npm install -g pnpm@9
fi
ok "pnpm $(pnpm -v)"

# PM2
if ! command -v pm2 &>/dev/null; then
  warn "PM2 not found, installing..."
  npm install -g pm2
fi
ok "PM2 $(pm2 -v)"

# Claude CLI
if ! command -v claude &>/dev/null; then
  warn "Claude Code CLI not found, installing..."
  npm install -g @anthropic-ai/claude-code
fi
ok "Claude CLI $(claude --version 2>/dev/null || echo 'installed')"

echo

# ── 2. Install dependencies ────────────────────────────
info "Installing dependencies..."
pnpm install
ok "Dependencies installed"
echo

# ── 3. Agent config ────────────────────────────────────
CONFIG_FILE=""
CONFIG_PATHS=(
  "./packages/agent/agent.config.json"
  "./packages/agent/ccm-agent.json"
  "$HOME/.ccm-agent.json"
)

for p in "${CONFIG_PATHS[@]}"; do
  if [ -f "$p" ]; then
    CONFIG_FILE="$p"
    break
  fi
done

NEED_CONFIG=false
if [ -z "$CONFIG_FILE" ]; then
  NEED_CONFIG=true
  CONFIG_FILE="$HOME/.ccm-agent.json"
  warn "No agent config found. Creating new config..."
elif [ "$RECONFIGURE" = true ]; then
  NEED_CONFIG=true
  info "Reconfiguring: $CONFIG_FILE"
else
  ok "Config found: $CONFIG_FILE"
  info "Run with --reconfigure to change settings"
fi

if [ "$NEED_CONFIG" = true ]; then
  # Read existing values as defaults (if reconfiguring)
  if [ -f "$CONFIG_FILE" ]; then
    EXISTING_ID=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('agentId',''))" 2>/dev/null || echo "")
    EXISTING_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('agentName',''))" 2>/dev/null || echo "")
    EXISTING_DATA=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('dataPath',''))" 2>/dev/null || echo "")
    EXISTING_PATHS=$(python3 -c "import json; print(','.join(json.load(open('$CONFIG_FILE')).get('allowedPaths',[])))" 2>/dev/null || echo "")
  fi

  # Detect defaults (use existing values if available)
  DEFAULT_ID="${EXISTING_ID:-$(hostname | tr '[:upper:]' '[:lower:]' | tr ' .' '-')}"
  DEFAULT_NAME="${EXISTING_NAME:-$(hostname)}"
  DEFAULT_PATH="${EXISTING_PATHS:-$HOME/projects/*}"
  DEFAULT_DATA_PATH="${EXISTING_DATA:-$HOME/CCManagerData}"
  # Check common data paths
  if [ -z "$EXISTING_DATA" ] && [ -d "$HOME/CCManagerData" ]; then
    DEFAULT_DATA_PATH="$HOME/CCManagerData"
  fi

  echo
  echo -e "${CYAN}Configure your agent:${NC}"
  echo

  read -rp "  Agent ID [$DEFAULT_ID]: " AGENT_ID
  AGENT_ID="${AGENT_ID:-$DEFAULT_ID}"

  read -rp "  Agent Name [$DEFAULT_NAME]: " AGENT_NAME
  AGENT_NAME="${AGENT_NAME:-$DEFAULT_NAME}"

  read -rp "  CCManagerData path [$DEFAULT_DATA_PATH]: " DATA_PATH
  DATA_PATH="${DATA_PATH:-$DEFAULT_DATA_PATH}"

  read -rp "  Allowed Paths [$DEFAULT_PATH]: " ALLOWED_PATHS
  ALLOWED_PATHS="${ALLOWED_PATHS:-$DEFAULT_PATH}"

  # Auth token — read existing or prompt for new one
  EXISTING_TOKEN=""
  if [ -f "$CONFIG_FILE" ]; then
    EXISTING_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null || echo "")
  fi

  if [ -n "$EXISTING_TOKEN" ]; then
    MASKED="${EXISTING_TOKEN:0:8}..."
    read -rp "  Auth Token [$MASKED]: " AUTH_TOKEN
    AUTH_TOKEN="${AUTH_TOKEN:-$EXISTING_TOKEN}"
  else
    echo
    info "Generate a token on the server: ccmng agent create --id $AGENT_ID"
    info "Or in Web UI → Settings → Agent Management → Register/Generate Token"
    echo
    read -rp "  Auth Token: " AUTH_TOKEN
    if [ -z "$AUTH_TOKEN" ]; then
      err "Auth token is required. Agent cannot connect without it."
      exit 1
    fi
  fi

  cat > "$CONFIG_FILE" <<CFGEOF
{
  "agentId": "$AGENT_ID",
  "agentName": "$AGENT_NAME",
  "dataPath": "$DATA_PATH",
  "authToken": "$AUTH_TOKEN",
  "allowedPaths": ["$ALLOWED_PATHS"],
  "blockedPaths": ["$HOME/.ssh", "$HOME/.gnupg"],
  "capabilities": []
}
CFGEOF

  echo
  ok "Config saved to $CONFIG_FILE"
fi

echo

# ── 4. Docker setup (auto-detect) ─────────────────────
# Executor is now per-project (not per-agent). If Docker is available,
# pre-build the runner image so Docker-mode projects are ready to go.
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

  # Get image name from config (if dockerConfig exists) or use default
  IMAGE=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('dockerConfig',{}).get('image','ccmanager-runner:latest'))" 2>/dev/null || echo "ccmanager-runner:latest")

  if ! docker image inspect "$IMAGE" &>/dev/null 2>&1; then
    if [ -f "$SCRIPT_DIR/packages/agent/docker/Dockerfile" ]; then
      info "Building Docker image '$IMAGE' for Docker-mode projects..."
      docker build -t "$IMAGE" "$SCRIPT_DIR/packages/agent/docker/"
      ok "Docker image built: $IMAGE"
    else
      info "Docker available but no Dockerfile found — Docker-mode projects will need manual image setup"
    fi
  else
    ok "Docker image ready: $IMAGE"
  fi
  echo
else
  info "Docker not available — only local executor projects will work"
  echo
fi

# ── 5. Build agent ──────────────────────────────────────
info "Building agent..."
pnpm --filter @ccmanager/agent build 2>/dev/null || pnpm run build:server
ok "Agent built"
echo

# ── 6. Start with PM2 ──────────────────────────────────
info "Starting agent with PM2..."

if pm2 describe ccm-agent &>/dev/null 2>&1; then
  info "ccm-agent already exists in PM2, restarting..."
  pm2 delete ccm-agent 2>/dev/null || true
fi

pm2 start npm --name ccm-agent \
  --cwd "$SCRIPT_DIR/packages/agent" \
  -- run dev

pm2 save

# ── 7. Connection check ────────────────────────────────
DATA_PATH=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['dataPath'])" 2>/dev/null || echo "")

info "Waiting for agent to connect..."
sleep 5

# Check PM2 status
if pm2 describe ccm-agent 2>/dev/null | grep -q "status.*online"; then
  ok "Agent process is running"
else
  RESTARTS=$(pm2 describe ccm-agent 2>/dev/null | grep restarts | awk '{print $NF}' || echo "?")
  if [ "$RESTARTS" != "0" ] && [ "$RESTARTS" != "?" ]; then
    err "Agent is crashing (restarts: $RESTARTS). Check logs: pm2 logs ccm-agent"
    exit 1
  fi
fi

# Try to read server URL and check health
if [ -n "$DATA_PATH" ] && [ -f "$DATA_PATH/server-url.txt" ]; then
  SERVER_URL=$(cat "$DATA_PATH/server-url.txt" | tr -d '[:space:]')
  if curl -sf "${SERVER_URL}/api/health" &>/dev/null; then
    ok "Manager server reachable at $SERVER_URL"
  else
    warn "Cannot reach manager at $SERVER_URL — agent will retry automatically"
  fi
fi

echo
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Agent is ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo
echo -e "  Config:    ${CYAN}$CONFIG_FILE${NC}"
echo -e "  Data Path: ${CYAN}$DATA_PATH${NC}"
echo
echo -e "  Logs:      ${YELLOW}pm2 logs ccm-agent${NC}"
echo -e "  Status:    ${YELLOW}pm2 status${NC}"
echo -e "  Restart:   ${YELLOW}pm2 restart ccm-agent${NC}"
echo

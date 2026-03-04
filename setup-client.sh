#!/usr/bin/env bash
# CCManager Agent (Client) - One-click setup & run script
# Usage: bash setup-client.sh
set -euo pipefail

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

if [ -z "$CONFIG_FILE" ]; then
  warn "No agent config found. Creating from template..."
  CONFIG_FILE="$HOME/.ccm-agent.json"

  # Detect defaults
  DEFAULT_ID=$(hostname | tr '[:upper:]' '[:lower:]' | tr ' .' '-')
  DEFAULT_NAME=$(hostname)
  DEFAULT_PATH="$HOME/projects/*"

  # Detect if this is a local setup (CCManagerData exists locally)
  DEFAULT_DATA_PATH="$HOME/CCManagerData"
  if [ -f "/home/CC/CCManagerData/server-url.txt" ]; then
    DEFAULT_DATA_PATH="/home/CC/CCManagerData"
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

  read -rp "  Executor (local/docker) [local]: " EXECUTOR
  EXECUTOR="${EXECUTOR:-local}"

  read -rp "  Allowed Paths [$DEFAULT_PATH]: " ALLOWED_PATHS
  ALLOWED_PATHS="${ALLOWED_PATHS:-$DEFAULT_PATH}"

  cat > "$CONFIG_FILE" <<CFGEOF
{
  "agentId": "$AGENT_ID",
  "agentName": "$AGENT_NAME",
  "dataPath": "$DATA_PATH",
  "executor": "$EXECUTOR",
  "allowedPaths": ["$ALLOWED_PATHS"],
  "blockedPaths": ["$HOME/.ssh", "$HOME/.gnupg"],
  "capabilities": []
}
CFGEOF

  echo
  ok "Config saved to $CONFIG_FILE"
  info "Auth token will be prompted on first run (generate via: ccmng agent create --id $AGENT_ID)"

  if [ "$EXECUTOR" = "docker" ]; then
    warn "Docker executor selected — you may need to configure dockerConfig in $CONFIG_FILE"
  fi
else
  ok "Config found: $CONFIG_FILE"
fi

echo

# ── 4. Docker setup (if docker executor) ───────────────
EXECUTOR=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['executor'])" 2>/dev/null || echo "local")

if [ "$EXECUTOR" = "docker" ]; then
  info "Docker executor mode — checking Docker..."

  if ! command -v docker &>/dev/null; then
    err "Docker not found. Please install Docker."
    err "  → https://docs.docker.com/get-docker/"
    exit 1
  fi
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

  if ! docker info &>/dev/null 2>&1; then
    err "Docker daemon not running or no permission."
    err "  → Start Docker or add user to docker group: sudo usermod -aG docker \$USER"
    exit 1
  fi
  ok "Docker daemon accessible"

  # Get image name from config
  IMAGE=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('dockerConfig',{}).get('image','ccmanager-runner:latest'))" 2>/dev/null || echo "ccmanager-runner:latest")

  if ! docker image inspect "$IMAGE" &>/dev/null 2>&1; then
    info "Docker image '$IMAGE' not found, building..."
    if [ -f "$SCRIPT_DIR/packages/agent/docker/Dockerfile" ]; then
      docker build -t "$IMAGE" "$SCRIPT_DIR/packages/agent/docker/"
      ok "Docker image built: $IMAGE"
    else
      err "Dockerfile not found at packages/agent/docker/Dockerfile"
      err "Please build or pull the image manually: docker pull $IMAGE"
      exit 1
    fi
  else
    ok "Docker image: $IMAGE"
  fi
  echo
else
  ok "Executor: local (no Docker required)"
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
echo -e "  Executor:  ${CYAN}$EXECUTOR${NC}"
echo
echo -e "  Logs:      ${YELLOW}pm2 logs ccm-agent${NC}"
echo -e "  Status:    ${YELLOW}pm2 status${NC}"
echo -e "  Restart:   ${YELLOW}pm2 restart ccm-agent${NC}"
echo

#!/bin/bash

# pi-coordination install script
# Creates symlinks from ~/.pi/agent/ to this repo

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

uninstall() {
    log "Uninstalling pi-coordination..."
    
    # Remove coordination extension symlink
    if [ -L "$PI_AGENT_DIR/extensions/coordination" ]; then
        rm "$PI_AGENT_DIR/extensions/coordination"
        log "Removed extensions/coordination symlink"
    fi
    
    # Remove agent symlinks
    if [ -L "$PI_AGENT_DIR/agents/coordinator.md" ]; then
        rm "$PI_AGENT_DIR/agents/coordinator.md"
        log "Removed agents/coordinator.md symlink"
    fi
    
    # Remove coordination agent directory symlinks
    if [ -d "$PI_AGENT_DIR/agents/coordination" ]; then
        rm -rf "$PI_AGENT_DIR/agents/coordination"
        log "Removed agents/coordination directory"
    fi
    
    # Remove skill symlink
    if [ -L "$PI_AGENT_DIR/skills/coordination" ]; then
        rm "$PI_AGENT_DIR/skills/coordination"
        log "Removed skills/coordination symlink"
    fi
    
    log "Uninstall complete"
    exit 0
}

# Check for --uninstall flag
if [ "$1" = "--uninstall" ] || [ "$1" = "-u" ]; then
    uninstall
fi

log "Installing pi-coordination..."

# Ensure pi agent directories exist
mkdir -p "$PI_AGENT_DIR/extensions"
mkdir -p "$PI_AGENT_DIR/agents"
mkdir -p "$PI_AGENT_DIR/skills"

# Clean up legacy hooks/tools from pre-extensions installs
LEGACY_PATHS=(
    "$PI_AGENT_DIR/tools/coordinate"
    "$PI_AGENT_DIR/tools/coord-output"
    "$PI_AGENT_DIR/hooks/coordination-async-notify.ts"
    "$PI_AGENT_DIR/hooks/coordination-async-notify"
)

for legacy in "${LEGACY_PATHS[@]}"; do
    if [ -L "$legacy" ]; then
        rm "$legacy"
        log "Removed legacy symlink: $legacy"
    elif [ -e "$legacy" ]; then
        warn "Legacy path exists (not a symlink): $legacy"
        warn "Remove it manually to avoid load errors."
    fi
done

# Create coordination extension symlink
if [ -e "$PI_AGENT_DIR/extensions/coordination" ]; then
    if [ -L "$PI_AGENT_DIR/extensions/coordination" ]; then
        warn "extensions/coordination symlink exists, replacing..."
        rm "$PI_AGENT_DIR/extensions/coordination"
    else
        error "extensions/coordination exists and is not a symlink. Please remove it first."
    fi
fi
ln -s "$SCRIPT_DIR/extensions/coordination" "$PI_AGENT_DIR/extensions/coordination"
log "Linked extensions/coordination"

# Create coordinator agent symlink
if [ -e "$PI_AGENT_DIR/agents/coordinator.md" ]; then
    if [ -L "$PI_AGENT_DIR/agents/coordinator.md" ]; then
        rm "$PI_AGENT_DIR/agents/coordinator.md"
    else
        warn "agents/coordinator.md exists, backing up..."
        mv "$PI_AGENT_DIR/agents/coordinator.md" "$PI_AGENT_DIR/agents/coordinator.md.bak"
    fi
fi
ln -s "$SCRIPT_DIR/agents/coordinator.md" "$PI_AGENT_DIR/agents/coordinator.md"
log "Linked agents/coordinator.md"

# Update worker.md if it exists (merge coordination section)
if [ -e "$PI_AGENT_DIR/agents/worker.md" ]; then
    if ! grep -q "Task: Coordination Worker" "$PI_AGENT_DIR/agents/worker.md"; then
        warn "agents/worker.md exists but missing coordination section"
        warn "You may want to manually add the coordination task section from:"
        warn "  $SCRIPT_DIR/agents/worker.md"
    else
        log "agents/worker.md already has coordination section"
    fi
else
    ln -s "$SCRIPT_DIR/agents/worker.md" "$PI_AGENT_DIR/agents/worker.md"
    log "Linked agents/worker.md"
fi

# Create coordination agent subdirectory for V2 agents (coordination/worker, coordination/scout, etc.)
mkdir -p "$PI_AGENT_DIR/agents/coordination"
log "Created agents/coordination directory"

# Link all agents from the repo to coordination/ subdirectory
for agent_file in "$SCRIPT_DIR/agents"/*.md; do
    agent_name=$(basename "$agent_file")
    target_path="$PI_AGENT_DIR/agents/coordination/$agent_name"
    if [ -L "$target_path" ]; then
        rm "$target_path"
    fi
    ln -s "$agent_file" "$target_path"
    log "Linked agents/coordination/$agent_name"
done

# Create coordination skill symlink
if [ -e "$PI_AGENT_DIR/skills/coordination" ]; then
    if [ -L "$PI_AGENT_DIR/skills/coordination" ]; then
        rm "$PI_AGENT_DIR/skills/coordination"
    else
        warn "skills/coordination exists, backing up..."
        mv "$PI_AGENT_DIR/skills/coordination" "$PI_AGENT_DIR/skills/coordination.bak"
    fi
fi
ln -s "$SCRIPT_DIR/skills/coordination" "$PI_AGENT_DIR/skills/coordination"
log "Linked skills/coordination"

log ""
log "Installation complete!"
log ""
log "The coordination extension is now available. Try:"
log "  coordinate({ plan: './plan.md', agents: ['worker', 'worker'] })"

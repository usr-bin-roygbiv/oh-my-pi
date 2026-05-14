#!/usr/bin/env bash
# robomp container entrypoint. No per-boot pip installs — everything is baked
# into the image; we only sanity-check the runtime mount and create state dirs.
#
# Used by both the orchestrator (CMD: `python -m robomp serve`) and the
# sibling gh-proxy (compose command: `python -m robomp.proxy serve`). The
# proxy role does NOT need a $PI_ROOT pi checkout — it never runs omp.
set -euo pipefail

# Detect the proxy role by inspecting the command. Compose passes `command:`
# as $@ here (after tini --), so $1=python, $2=-m, $3=robomp.proxy is the
# canonical shape; we also accept a single concatenated arg for safety.
is_proxy_role=0
if [ "${1:-}" = "python" ] && [ "${2:-}" = "-m" ] && [[ "${3:-}" == robomp.proxy* ]]; then
    is_proxy_role=1
elif [[ "${1:-}" == *"robomp.proxy"* ]]; then
    is_proxy_role=1
fi

if [ "$is_proxy_role" -eq 0 ]; then
    : "${PI_ROOT:=/work/pi}"
    if [ ! -d "$PI_ROOT/packages/coding-agent" ]; then
        echo "robomp: PI_ROOT=$PI_ROOT does not look like a pi checkout (no packages/coding-agent/)" >&2
        exit 1
    fi
fi

mkdir -p /data/workspaces /data/logs
# Persistent build caches under the /data volume. CARGO_HOME, CARGO_TARGET_DIR,
# RUSTUP_HOME, and BUN_INSTALL_CACHE_DIR are pinned to these paths in the image
# ENV so every per-issue worktree shares one cargo target and one bun cache.
mkdir -p /data/cache/cargo /data/cache/cargo-target /data/cache/rustup /data/cache/bun-cache
exec "$@"

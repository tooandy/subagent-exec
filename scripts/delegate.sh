#!/usr/bin/env bash
#
# delegate.sh — convenience wrapper around subagent-exec.
#
# Usage:
#   delegate.sh <task.json>                # run a single task
#   delegate.sh --task-id ID <task.json>   # override task_id
#
# Equivalent to:
#   subagent-exec --task <task.json>
#
# This script exists so Codex can `$skill:subagent-exec/scripts/delegate.sh`
# without first checking whether subagent-exec is on PATH.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: delegate.sh <task.json> [--task-id ID]" >&2
  exit 64
fi

exec subagent-exec "$@"

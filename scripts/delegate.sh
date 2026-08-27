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
  echo "usage: delegate.sh [--task-id ID] <task.json>" >&2
  exit 64
fi

task_id=""
if [[ "${1:-}" == "--task-id" ]]; then
  if [[ $# -lt 3 ]]; then
    echo "delegate.sh: --task-id requires ID and task.json" >&2
    exit 64
  fi
  task_id=$2
  shift 2
fi

if [[ $# -ne 1 ]]; then
  echo "usage: delegate.sh [--task-id ID] <task.json>" >&2
  exit 64
fi

if [[ -n "$task_id" ]]; then
  exec subagent-exec --task "$1" --task-id "$task_id"
fi
exec subagent-exec --task "$1"

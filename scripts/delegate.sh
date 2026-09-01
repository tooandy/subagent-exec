#!/usr/bin/env bash
#
# delegate.sh — convenience wrapper around subagent-exec.
#
# Usage:
#   delegate.sh [--continue <task_id>] [--feedback <file>] [task.json]
#
# Examples:
#   delegate.sh task.json
#   delegate.sh --task-id TASK-123 task.json
#   delegate.sh --continue TASK-123 --feedback review.json
#
# Equivalent to:
#   subagent-exec --task <task.json>
#   subagent-exec --continue <task_id> --feedback <feedback.json>
#
# This script exists so Codex can `$skill:subagent-exec/scripts/delegate.sh`
# without first checking whether subagent-exec is on PATH.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: delegate.sh [--continue <task_id>] [--feedback <file>] [task.json]" >&2
  exit 64
fi

continue_id=""
feedback_file=""
task_file=""
task_id_override=""
seen_continue=0
seen_feedback=0
seen_task_id=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue)
      if [[ $# -lt 2 ]]; then
        echo "delegate.sh: --continue requires a task_id" >&2
        exit 64
      fi
      if [[ $seen_continue -eq 1 ]]; then
        echo "delegate.sh: --continue may only be specified once" >&2
        exit 64
      fi
      seen_continue=1
      continue_id="$2"
      shift 2
      ;;
    --feedback)
      if [[ $# -lt 2 ]]; then
        echo "delegate.sh: --feedback requires a path" >&2
        exit 64
      fi
      if [[ $seen_feedback -eq 1 ]]; then
        echo "delegate.sh: --feedback may only be specified once" >&2
        exit 64
      fi
      seen_feedback=1
      feedback_file="$2"
      shift 2
      ;;
    --task-id)
      if [[ $# -lt 2 ]]; then
        echo "delegate.sh: --task-id requires an ID" >&2
        exit 64
      fi
      if [[ $seen_task_id -eq 1 ]]; then
        echo "delegate.sh: --task-id may only be specified once" >&2
        exit 64
      fi
      seen_task_id=1
      task_id_override="$2"
      shift 2
      ;;
    --*)
      echo "delegate.sh: unknown option: $1" >&2
      exit 64
      ;;
    *)
      if [[ -n "$task_file" ]]; then
        echo "delegate.sh: only one task file may be specified" >&2
        exit 64
      fi
      task_file="$1"
      shift
      ;;
  esac
done

# Continue path
if [[ -n "$continue_id" ]]; then
  if [[ -n "$task_file" || -n "$task_id_override" ]]; then
    echo "delegate.sh: --continue cannot be combined with a task file or --task-id" >&2
    exit 64
  fi
  if [[ -z "$feedback_file" ]]; then
    echo "delegate.sh: --continue requires --feedback <file>" >&2
    exit 64
  fi
  exec subagent-exec \
    --continue "$continue_id" \
    --feedback "$feedback_file"
fi

if [[ -n "$feedback_file" ]]; then
  echo "delegate.sh: --feedback requires --continue <task_id>" >&2
  exit 64
fi

# Start path
if [[ -z "$task_file" ]]; then
  echo "usage: delegate.sh [--continue <task_id>] [--feedback <file>] [task.json]" >&2
  exit 64
fi

if [[ -n "$task_id_override" ]]; then
  exec subagent-exec --task "$task_file" --task-id "$task_id_override"
fi
exec subagent-exec --task "$task_file"

import type {
  RpcEvent
} from "./rpc.js";

import type {
  ExecutionInfo,
  ScopeInfo,
  UsageInfo,
  VerificationResult,
  WorkerError,
  WorkerInfo,
  WorkerResult,
  Task
} from "./types.js";
import { extractAcceptanceEvidence } from "./evidence.js";
import { evaluateResultCircuit } from "./circuit.js";
import type { SessionMetadata } from "./types.js";

export interface RpcState {
  settled: boolean;

  agentStarted: boolean;

  agentEnded: boolean;

  /*
   * Final assistant message (only set from assistant role messages).
   */
  assistantMessage?: string;

  usage?: UsageInfo;

  changedFiles?: string[];
}

function extractText(
  message: unknown
): string | undefined {
  if (
    !message ||
    typeof message !== "object"
  ) {
    return undefined;
  }

  const m =
    message as Record<string, unknown>;

  const content = m.content;

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];

  for (const item of content) {
    if (
      item &&
      typeof item === "object"
    ) {
      const block =
        item as Record<string, unknown>;

      if (
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        parts.push(block.text);
      }
    }
  }

  const result =
    parts.join("");

  return result || undefined;
}

function isAssistantMessage(
  message: unknown
): boolean {
  if (
    !message ||
    typeof message !== "object"
  ) {
    return false;
  }

  const role =
    (message as Record<string, unknown>).role;

  return role === "assistant";
}

export function updateRpcState(
  state: RpcState,
  event: RpcEvent
): void {
  switch (event.type) {
    case "agent_start":
      state.agentStarted = true;
      break;

    case "agent_end":
      state.agentEnded = true;

      if (Array.isArray(event.messages)) {
        for (
          const message of event.messages
        ) {
          if (!isAssistantMessage(message)) {
            continue;
          }

          const text =
            extractText(message);

          if (text) {
            state.assistantMessage = text;
          }
        }
      }

      break;

    case "agent_settled":
      state.settled = true;
      break;

    case "message_end": {
      if (isAssistantMessage(event.message)) {
        const text =
          extractText(event.message);

        if (text) {
          state.assistantMessage = text;
        }
      }

      break;
    }

    case "message_start": {
      if (isAssistantMessage(event.message)) {
        const text =
          extractText(event.message);

        if (text) {
          state.assistantMessage = text;
        }
      }

      break;
    }

    case "message_update": {
      const assistantEvent =
        event.assistantMessageEvent;

      if (
        assistantEvent &&
        typeof assistantEvent === "object"
      ) {
        const e =
          assistantEvent as Record<string, unknown>;

        if (
          e.type === "text_delta" &&
          typeof e.delta === "string"
        ) {
          state.assistantMessage =
            (state.assistantMessage ?? "") +
            e.delta;
        }
      }

      break;
    }
  }
}

export function buildResult(
  task: Task,
  worker: WorkerInfo,
  execution: ExecutionInfo,
  state: RpcState,
  scope: ScopeInfo,
  verification: VerificationResult,
  error: WorkerError | null,
  iteration: number,
  previousFailures: SessionMetadata["failure_history"] = []
): WorkerResult {
  const acceptanceEvidence = extractAcceptanceEvidence(state.assistantMessage, task.acceptance_criteria, {
    verification,
    changedFiles: scope.changed_files
  });
  if (!error && acceptanceEvidence.handoff) {
    error = {
      category: acceptanceEvidence.handoff.type,
      code: acceptanceEvidence.handoff.type === "architecture"
        ? "ARCHITECTURE_DECISION_REQUIRED"
        : "REQUIREMENT_CLARIFICATION_REQUIRED",
      message: acceptanceEvidence.handoff.reason,
      retryable: false
    };
  }
  let status:
    | "success"
    | "failed"
    | "cancelled"
    | "timeout"
    | "needs_continuation";

  if (error?.code === "TASK_TIMEOUT") {
    status = "timeout";
  } else if (error?.code === "TASK_CANCELLED") {
    status = "cancelled";
  } else if (error) {
    status = "failed";
  } else {
    status = "success";
  }

  if (error && !acceptanceEvidence.recommended_next_action) {
    acceptanceEvidence.recommended_next_action = error.retryable
      ? "Return to the coordinator to decide whether to retry with revised instructions."
      : "Return to the coordinator for manual review and takeover.";
  }

  const result: WorkerResult = {
    schema_version: "1.0",

    task_id: task.task_id,

    status,

    worker,

    execution,

    result: {
      summary:
        state.assistantMessage
          ? state.assistantMessage.slice(0, 4000)
          : undefined,

      final_message:
        state.assistantMessage,

      changed_files:
        scope.changed_files
    },

    scope,

    verification,

    acceptance_evidence: acceptanceEvidence,

    continuation: { allow_continuation: false, state: "terminal_success" },

    usage: state.usage,

    iteration,

    error,

    metadata: task.metadata
  };
  result.continuation = evaluateResultCircuit(result, previousFailures);
  const maxIterations = task.iteration?.max_iterations ??
    (task.execution_policy?.mode === "checkpoint" ? 2 : 1);
  if (result.error && result.continuation.allow_continuation && iteration >= maxIterations) {
    result.continuation = {
      allow_continuation: false,
      state: "coordinator_required",
      reason: "iteration_limit",
      failure_class: result.continuation.failure_class
    };
  }
  return result;
}

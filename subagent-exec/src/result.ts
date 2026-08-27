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

export interface RpcState {
  settled: boolean;

  agentStarted: boolean;

  agentEnded: boolean;

  /*
   * Final assistant message (only set from assistant role messages).
   * Renamed from finalMessage for clarity — this field MUST only
   * be populated from assistant messages, never from user prompt.
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

/*
 * Per review-3: only assistant-role messages should populate
 * the final assistant message. User messages must never overwrite it.
 */
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

      /*
       * agent_end may include messages array.
       * Only update from assistant messages.
       */
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
      /*
       * Only update on assistant message.
       * Skip user message (the prompt itself).
       */
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
      /*
       * message_update carries assistantMessageEvent with
       * streaming text_delta events. These are always assistant.
       * Accumulate into assistantMessage.
       */
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
  error: WorkerError | null
): WorkerResult {
  let status:
    | "success"
    | "failed"
    | "cancelled"
    | "timeout";

  if (error?.code === "TASK_TIMEOUT") {
    status = "timeout";
  } else if (
    error?.code === "TASK_CANCELLED"
  ) {
    status = "cancelled";
  } else if (error) {
    status = "failed";
  } else {
    status = "success";
  }

  return {
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

    usage: state.usage,

    error,

    metadata: task.metadata
  };
}

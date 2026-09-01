export type LogEventName =
  | "task_started"
  | "process_spawned"
  | "prompt_sent"
  | "prompt_accepted"
  | "prompt_rejected"
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "tool_execution_start"
  | "tool_execution_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "turn_start"
  | "turn_end"
  | "shutdown_abort_requested"
  | "shutdown_abort_sent"
  | "shutdown_abort_failed"
  | "process_exited_gracefully"
  | "process_exited_sigterm"
  | "process_exited_sigkill"
  | "session_stats_requested"
  | "session_stats_response"
  | "session_stats_received"
  | "session_stats_parse_failed"
  | "session_stats_failed"
  | "session_stats_timeout"
  | "session_save_failed"
  | "child_exit_during_work"
  | "verification_start"
  | "verification_end"
  | "scope_check_start"
  | "scope_check_end"
  | "scope_check_error"
  | "task_timeout"
  | "task_cancelled"
  | "task_finished"
  | "signal_received"
  | "signal_force_exit"
  | "process_exit"
  | "abort_requested"
  | "abort_response"
  | "abort_rpc_failed"
  | "abort_grace_timeout"
  | "sending_sigterm"
  | "sending_sigkill"
  | "sigterm_grace_timeout"
  | "extension_error"
  | "auto_retry_start"
  | "compaction_start"
  | "unknown_event"
  | "pi_stderr"
  | "rpc_connected";

export interface LogEvent {
  schema_version: "1.0";
  ts: string;
  task_id: string;
  event: LogEventName;
  data?: Record<string, unknown>;
}

export class Logger {
  constructor(
    private readonly taskId: string,
    private readonly enabled = true
  ) {}

  log(
    event: LogEventName,
    data: Record<string, unknown> = {}
  ): void {
    if (!this.enabled) {
      return;
    }

    const payload: LogEvent = {
      schema_version: "1.0",
      ts: new Date().toISOString(),
      task_id: this.taskId,
      event,
      data
    };

    process.stderr.write(
      JSON.stringify(payload) + "\n"
    );
  }
}

import type { Task } from "./types.js";

export interface LogEvent {
  ts: string;
  task_id: string;
  event: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly task: Task,
    private readonly enabled = true
  ) {}

  log(
    event: string,
    extra: Record<string, unknown> = {}
  ): void {
    if (!this.enabled) {
      return;
    }

    const payload: LogEvent = {
      ts: new Date().toISOString(),
      task_id: this.task.task_id,
      event,
      ...extra
    };

    process.stderr.write(
      JSON.stringify(payload) + "\n"
    );
  }
}

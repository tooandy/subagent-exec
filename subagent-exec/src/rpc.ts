import {
  StringDecoder
} from "node:string_decoder";

import {
  setTimeout as sleep
} from "node:timers/promises";

import type {
  ChildProcessWithoutNullStreams
} from "node:child_process";

import {
  protocolError
} from "./errors.js";

export interface RpcEvent {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

export interface RpcResponse extends RpcEvent {
  type: "response";
  command?: string;
  success?: boolean;
  error?: string;
}

export type RpcListener =
  (event: RpcEvent) => void;

const DEFAULT_RPC_DEADLINE_MS = 60_000;

export class PiRpcClient {
  private readonly decoder =
    new StringDecoder("utf8");

  private buffer = "";

  private readonly listeners =
    new Set<RpcListener>();

  private readonly pending =
    new Map<
      string,
      {
        resolve: (event: RpcResponse) => void;
        reject: (error: Error) => void;
        deadlineTimer?: ReturnType<typeof setTimeout>;
      }
    >();

  private sequence = 0;

  private stderrBuffer = "";

  constructor(
    private readonly child:
      ChildProcessWithoutNullStreams
  ) {
    this.attach();
  }

  private attach(): void {
    this.child.stdout.on(
      "data",
      (chunk: Buffer) => {
        this.handleStdout(chunk);
      }
    );

    this.child.stderr.on(
      "data",
      (chunk: Buffer) => {
        this.handleStderr(chunk);
      }
    );

    this.child.on(
      "exit",
      (code, signal) => {
        const error = new Error(
          `Pi process exited: code=${code}, signal=${signal}`
        );

        for (const pending of this.pending.values()) {
          // Clear deadline timer to avoid double-reject
          if (pending.deadlineTimer) {
            clearTimeout(pending.deadlineTimer);
          }
          pending.reject(error);
        }

        this.pending.clear();
      }
    );
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);

    while (true) {
      const index =
        this.buffer.indexOf("\n");

      if (index === -1) {
        break;
      }

      let line =
        this.buffer.slice(0, index);

      this.buffer =
        this.buffer.slice(index + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (!line) {
        continue;
      }

      this.handleLine(line);
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrBuffer +=
      chunk.toString("utf8");

    const lines =
      this.stderrBuffer.split(/\r?\n/);

    this.stderrBuffer =
      lines.pop() ?? "";

    for (const line of lines) {
      if (line.length > 0) {
        this.emit({
          type: "pi_stderr",
          line
        });
      }
    }
  }

  private handleLine(line: string): void {
    let event: RpcEvent;

    try {
      event = JSON.parse(line);
    } catch (error) {
      this.emit({
        type: "protocol_error",
        error:
          protocolError(
            "INVALID_JSON",
            "Invalid JSON received from Pi RPC",
            {
              line,
              cause: String(error)
            }
          )
      });

      return;
    }

    if (
      event.type === "response" &&
      typeof event.id === "string"
    ) {
      const pending =
        this.pending.get(event.id);

      if (pending) {
        this.pending.delete(event.id);

        if (pending.deadlineTimer) {
          clearTimeout(pending.deadlineTimer);
        }

        pending.resolve(
          event as RpcResponse
        );
      }
    }

    this.emit(event);
  }

  on(listener: RpcListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: RpcEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Send an RPC command and wait for the response with a deadline.
   *
   * @param command    The RPC command payload
   * @param deadlineMs Max time to wait for a response (default 60s).
   *                   The Pi process is expected to respond within this time.
   */
  async send(
    command: Record<string, unknown>,
    deadlineMs = DEFAULT_RPC_DEADLINE_MS
  ): Promise<RpcResponse> {
    const id =
      `subagent-exec-${++this.sequence}`;

    const payload = {
      id,
      ...command
    };

    return new Promise(
      (resolve, reject) => {
        let settled = false;

        // Deadline timer — ensures we never leave a pending promise.
        const deadlineTimer = setTimeout(() => {
          if (settled) return;
          settled = true;

          // Remove from pending map so handleLine won't double-resolve.
          this.pending.delete(id);

          reject(
            new Error(
              `RPC command ${command.type} timed out after ${deadlineMs}ms`
            )
          );
        }, deadlineMs);

        this.pending.set(
          id,
          {
            resolve: (response) => {
              if (settled) return;
              settled = true;
              clearTimeout(deadlineTimer);
              resolve(response);
            },
            reject: (error) => {
              if (settled) return;
              settled = true;
              clearTimeout(deadlineTimer);
              reject(error);
            },
            deadlineTimer
          }
        );

        try {
          const written = this.child.stdin.write(
            JSON.stringify(payload) + "\n"
          );
          if (!written) {
            // Buffer is full — reject immediately.
            this.pending.delete(id);
            clearTimeout(deadlineTimer);
            reject(
              new Error(
                "stdin write buffer full; Pi process may be unresponsive"
              )
            );
          }
        } catch (error) {
          this.pending.delete(id);
          clearTimeout(deadlineTimer);
          reject(error);
        }
      }
    );
  }

  /**
   * Send prompt and wait for acceptance with a deadline.
   * The deadline prevents hanging when Pi silently accepts without
   * emitting a response event.
   */
  async prompt(
    message: string,
    deadlineMs = DEFAULT_RPC_DEADLINE_MS
  ): Promise<RpcResponse> {
    return this.send(
      { type: "prompt", message },
      deadlineMs
    );
  }

  /**
   * Send abort signal with a deadline.
   * This is used during shutdown to interrupt the current Pi operation.
   */
  async abort(
    deadlineMs = 10_000
  ): Promise<RpcResponse> {
    return this.send(
      { type: "abort" },
      deadlineMs
    );
  }

  async getState(
    deadlineMs = DEFAULT_RPC_DEADLINE_MS
  ): Promise<RpcResponse> {
    return this.send(
      { type: "get_state" },
      deadlineMs
    );
  }

  async getSessionStats(
    deadlineMs = DEFAULT_RPC_DEADLINE_MS
  ): Promise<RpcResponse> {
    return this.send(
      { type: "get_session_stats" },
      deadlineMs
    );
  }

  /**
   * Clean up all pending requests and timers.
   * Call this during shutdown to ensure no timers or promises are left dangling.
   */
  cleanup(): void {
    for (const pending of this.pending.values()) {
      if (pending.deadlineTimer) {
        clearTimeout(pending.deadlineTimer);
      }
      pending.reject(
        new Error("PiRpcClient.cleanup() called")
      );
    }
    this.pending.clear();
    this.listeners.clear();
  }
}

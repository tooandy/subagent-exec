import {
  StringDecoder
} from "node:string_decoder";

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

  send(
    command: Record<string, unknown>
  ): Promise<RpcResponse> {
    const id =
      `subagent-exec-${++this.sequence}`;

    const payload = {
      id,
      ...command
    };

    return new Promise(
      (resolve, reject) => {
        this.pending.set(
          id,
          {
            resolve,
            reject
          }
        );

        try {
          this.child.stdin.write(
            JSON.stringify(payload) + "\n"
          );
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      }
    );
  }

  async prompt(
    message: string
  ): Promise<RpcResponse> {
    return this.send({
      type: "prompt",
      message
    });
  }

  async abort(): Promise<RpcResponse> {
    return this.send({
      type: "abort"
    });
  }

  async getState(): Promise<RpcResponse> {
    return this.send({
      type: "get_state"
    });
  }
}

import { StringDecoder } from "node:string_decoder";
import { protocolError } from "./errors.js";
export class PiRpcClient {
    child;
    decoder = new StringDecoder("utf8");
    buffer = "";
    listeners = new Set();
    pending = new Map();
    sequence = 0;
    stderrBuffer = "";
    constructor(child) {
        this.child = child;
        this.attach();
    }
    attach() {
        this.child.stdout.on("data", (chunk) => {
            this.handleStdout(chunk);
        });
        this.child.stderr.on("data", (chunk) => {
            this.handleStderr(chunk);
        });
        this.child.on("exit", (code, signal) => {
            const error = new Error(`Pi process exited: code=${code}, signal=${signal}`);
            for (const pending of this.pending.values()) {
                pending.reject(error);
            }
            this.pending.clear();
        });
    }
    handleStdout(chunk) {
        this.buffer += this.decoder.write(chunk);
        while (true) {
            const index = this.buffer.indexOf("\n");
            if (index === -1) {
                break;
            }
            let line = this.buffer.slice(0, index);
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
    handleStderr(chunk) {
        this.stderrBuffer +=
            chunk.toString("utf8");
        const lines = this.stderrBuffer.split(/\r?\n/);
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
    handleLine(line) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch (error) {
            this.emit({
                type: "protocol_error",
                error: protocolError("INVALID_JSON", "Invalid JSON received from Pi RPC", {
                    line,
                    cause: String(error)
                })
            });
            return;
        }
        if (event.type === "response" &&
            typeof event.id === "string") {
            const pending = this.pending.get(event.id);
            if (pending) {
                this.pending.delete(event.id);
                pending.resolve(event);
            }
        }
        this.emit(event);
    }
    on(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    emit(event) {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
    send(command) {
        const id = `subagent-exec-${++this.sequence}`;
        const payload = {
            id,
            ...command
        };
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve,
                reject
            });
            try {
                this.child.stdin.write(JSON.stringify(payload) + "\n");
            }
            catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    async prompt(message) {
        return this.send({
            type: "prompt",
            message
        });
    }
    async abort() {
        return this.send({
            type: "abort"
        });
    }
    async getState() {
        return this.send({
            type: "get_state"
        });
    }
}
//# sourceMappingURL=rpc.js.map
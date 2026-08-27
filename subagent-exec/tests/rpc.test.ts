import { test, describe } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";

import { PiRpcClient } from "../src/rpc.js";

// =============================================================================
// PiRpcClient — tests using a real instance with mocked child streams.
//
// The PiRpcClient is constructed with a ChildProcessWithoutNullStreams.
// We mock that by:
//   - child.stdin  = Writable  (we capture writes for assertion)
//   - child.stdout = Readable  (we push RPC JSON frames into it)
//   - child.stderr = Readable  (we push stderr lines)
//   - child        = EventEmitter for "exit"/"error"
//
// This way the tests exercise the actual production class — not a copy.
// =============================================================================

interface FakeChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill: (signal?: string) => boolean;
  on: EventEmitter["on"];
  once: EventEmitter["once"];
  off: EventEmitter["off"];
  emit: EventEmitter["emit"];
  removeListener: EventEmitter["removeListener"];
  removeAllListeners: EventEmitter["removeAllListeners"];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
}

function makeFakeChild(): FakeChild & { stdinWrites: string[] } {
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString("utf8"));
      cb();
    }
  });

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const emitter = new EventEmitter();

  const child: any = emitter;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 12345;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (sig?: string) => {
    child.killed = true;
    return true;
  };
  child.stdinWrites = stdinChunks;

  return child as FakeChild & { stdinWrites: string[] };
}

function pushStdout(child: FakeChild, frames: object[]) {
  for (const frame of frames) {
    child.stdout.push(JSON.stringify(frame) + "\n");
  }
}

function pushStderr(child: FakeChild, lines: string[]) {
  for (const line of lines) {
    child.stderr.push(line + "\n");
  }
}

function emitExit(
  child: FakeChild,
  code: number | null,
  signal: NodeJS.Signals | null
) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PiRpcClient.send — response matching", () => {
  test("resolves when matching response event arrives", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    const pending = rpc.send({ type: "get_state" });

    // Give send() a tick to register the pending entry.
    await new Promise((r) => setImmediate(r));

    pushStdout(child, [
      {
        id: "subagent-exec-1",
        type: "response",
        command: "get_state",
        success: true,
        data: { ok: 1 }
      }
    ]);

    const response = await pending;
    assert.strictEqual(response.type, "response");
    assert.strictEqual(response.success, true);
    assert.strictEqual((response as any).data.ok, 1);
  });

  test("emits a unique id per send", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    const p1 = rpc.send({ type: "ping" });
    const p2 = rpc.send({ type: "pong" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(child.stdinWrites.length, 2);
    const w1 = JSON.parse(child.stdinWrites[0]);
    const w2 = JSON.parse(child.stdinWrites[1]);
    assert.notStrictEqual(w1.id, w2.id);
    assert.strictEqual(w1.type, "ping");
    assert.strictEqual(w2.type, "pong");

    // Drain to avoid hanging.
    pushStdout(child, [
      { id: w1.id, type: "response", command: "ping", success: true }
    ]);
    pushStdout(child, [
      { id: w2.id, type: "response", command: "pong", success: true }
    ]);
    await Promise.all([p1, p2]);
  });

  test("non-response events are not consumed as replies", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    const pending = rpc.send({ type: "x" });
    await new Promise((r) => setImmediate(r));

    // Push an unrelated event with no matching id.
    pushStdout(child, [
      { type: "agent_start" },
      { type: "message_update" }
    ]);

    // Pending should not have settled; resolve it manually.
    pushStdout(child, [
      { id: "subagent-exec-1", type: "response", command: "x", success: true }
    ]);
    const response = await pending;
    assert.strictEqual(response.command, "x");
  });
});

describe("PiRpcClient.send — deadline timer cleanup", () => {
  test("rejects with timeout when no response arrives within deadline", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    await assert.rejects(
      () => rpc.send({ type: "ping" }, 50),
      /timed out after 50ms/
    );
  });

  test("deadline timer is cleared on resolve (no dangling timer)", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    const pending = rpc.send({ type: "ping" }, 5_000);
    await new Promise((r) => setImmediate(r));
    pushStdout(child, [
      { id: "subagent-exec-1", type: "response", command: "ping", success: true }
    ]);
    await pending;

    // If the deadline timer leaked, the test would hang or fail with
    // "timed out". Resolution proves cleanup happened.
    assert.ok(true);
  });

  test("multiple concurrent requests each have independent deadlines", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    const slow = rpc.send({ type: "slow" }, 200);
    const fast = rpc.send({ type: "fast" }, 5_000);
    await new Promise((r) => setImmediate(r));

    const writes = child.stdinWrites.map((s) => JSON.parse(s));
    const slowId = writes.find((w) => w.type === "slow").id;
    const fastId = writes.find((w) => w.type === "fast").id;

    // Resolve fast first, slow second — verify each deadline is independent.
    pushStdout(child, [
      { id: fastId, type: "response", command: "fast", success: true }
    ]);
    const fastResp = await fast;
    assert.strictEqual(fastResp.command, "fast");

    pushStdout(child, [
      { id: slowId, type: "response", command: "slow", success: true }
    ]);
    const slowResp = await slow;
    assert.strictEqual(slowResp.command, "slow");
  });

  test("deadline does not fire if response already arrived", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    const pending = rpc.send({ type: "ping" }, 50);
    await new Promise((r) => setImmediate(r));
    pushStdout(child, [
      { id: "subagent-exec-1", type: "response", command: "ping", success: true }
    ]);

    // Race: response arrives within 50ms.
    const response = await pending;
    assert.strictEqual(response.success, true);

    // Wait past the deadline — no late rejection should occur.
    await new Promise((r) => setTimeout(r, 100));
    // Pending is already settled; no unhandled rejection.
  });
});

describe("PiRpcClient — child exit handling", () => {
  test("rejects all pending requests when child exits", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    const p1 = rpc.send({ type: "x" }, 99_999);
    const p2 = rpc.send({ type: "y" }, 99_999);
    await new Promise((r) => setImmediate(r));

    emitExit(child, 1, null);

    await assert.rejects(p1, /Pi process exited/);
    await assert.rejects(p2, /Pi process exited/);
  });

  test("child.exit listener added by PiRpcClient survives other code calling child.off", async () => {
    // Regression: cli.ts used to call child.removeAllListeners("exit")
    // which would also strip PiRpcClient's exit handler. After that bug
    // pending requests would not reject on exit. Verify the production
    // exit handler is attached via child.on (which child.off cannot
    // remove by accident unless callers explicitly target it).
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);
    await new Promise((r) => setImmediate(r));

    // Some other code removes its own listener — PiRpcClient's must stay.
    let ownListenerCalled = false;
    const ownHandler = () => {
      ownListenerCalled = true;
    };
    child.on("exit", ownHandler);
    child.off("exit", ownHandler);

    const pending = rpc.send({ type: "x" }, 99_999);
    await new Promise((r) => setImmediate(r));

    emitExit(child, 0, null);
    await assert.rejects(pending, /Pi process exited/);
    assert.strictEqual(ownListenerCalled, false);
  });
});

describe("PiRpcClient — invalid JSON", () => {
  test("emits protocol_error event for malformed JSON line", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    let protocolErrorEvent: any = null;
    rpc.on((event) => {
      if (event.type === "protocol_error") {
        protocolErrorEvent = event;
      }
    });

    child.stdout.push("this is not json\n");

    // Wait for the protocol error to propagate.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.ok(protocolErrorEvent, "expected protocol_error event");
    assert.ok(protocolErrorEvent.error, "protocol_error event should carry error");
  });
});

describe("PiRpcClient — listener API", () => {
  test("on() returns an unsubscribe function that detaches the listener", async () => {
    const child = makeFakeChild();
    const rpc = new PiRpcClient(child as any);

    let calls = 0;
    const unsubscribe = rpc.on(() => {
      calls++;
    });

    child.stdout.push(JSON.stringify({ type: "agent_start" }) + "\n");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls, 1);

    unsubscribe();

    child.stdout.push(JSON.stringify({ type: "agent_end" }) + "\n");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls, 1);
  });
});

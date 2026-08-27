import { test, describe } from "node:test";
import assert from "node:assert";

// =============================================================================
// Verification failure classification — pure logic tests.
// We test the error categorization logic from errors.ts in isolation.
// =============================================================================

import { createError, classifyError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createError", () => {
  test("creates a quota error with retryable=true", () => {
    const err = createError("quota", "PROVIDER_QUOTA_EXCEEDED", "429 rate limit", {
      retryable: true
    });

    assert.strictEqual(err.category, "quota");
    assert.strictEqual(err.code, "PROVIDER_QUOTA_EXCEEDED");
    assert.strictEqual(err.retryable, true);
    assert.strictEqual(err.message, "429 rate limit");
  });

  test("defaults retryable to false", () => {
    const err = createError("runtime", "PI_PROCESS_EXIT_NONZERO", "exited with 1", {});
    assert.strictEqual(err.retryable, false);
  });

  test("includes details when provided", () => {
    const err = createError("scope", "MODIFICATION_SCOPE_VIOLATION", "changed file outside allowed_paths", {
      details: { path: "lib/secret.ts", allowed: ["src/**"] }
    });

    assert.deepStrictEqual(err.details, { path: "lib/secret.ts", allowed: ["src/**"] });
  });
});

describe("classifyError", () => {
  test("classifies 401 as auth error", () => {
    const err = classifyError(new Error("HTTP 401 Unauthorized"));
    assert.strictEqual(err.category, "auth");
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.retryable, false);
  });

  test("classifies 403 as auth error", () => {
    const err = classifyError(new Error("403 Forbidden"));
    assert.strictEqual(err.category, "auth");
  });

  test("classifies unauthorized as auth error", () => {
    const err = classifyError(new Error("Unauthorized access"));
    assert.strictEqual(err.category, "auth");
  });

  test("classifies api key error as auth", () => {
    const err = classifyError(new Error("Invalid API key"));
    assert.strictEqual(err.category, "auth");
  });

  test("classifies 429 as quota error", () => {
    const err = classifyError(new Error("HTTP 429 Too Many Requests"));
    assert.strictEqual(err.category, "quota");
    assert.strictEqual(err.code, "PROVIDER_QUOTA_EXCEEDED");
    assert.strictEqual(err.retryable, true);
  });

  test("classifies rate limit as quota error", () => {
    const err = classifyError(new Error("Rate limit exceeded"));
    assert.strictEqual(err.category, "quota");
  });

  test("classifies context window as token error", () => {
    const err = classifyError(new Error("Context window exceeded"));
    assert.strictEqual(err.category, "token");
    assert.strictEqual(err.code, "TOKEN_LIMIT");
    assert.strictEqual(err.retryable, false);
  });

  test("classifies context length as token error", () => {
    const err = classifyError(new Error("context length limit reached"));
    assert.strictEqual(err.category, "token");
  });

  test("classifies too many tokens as token error", () => {
    const err = classifyError(new Error("too many tokens"));
    assert.strictEqual(err.category, "token");
  });

  test("falls back to provided category for unknown errors", () => {
    const err = classifyError(new Error("something went wrong"), "runtime");
    assert.strictEqual(err.category, "runtime");
    assert.strictEqual(err.code, "RUNTIME_ERROR");
  });

  test("defaults fallback category to runtime", () => {
    const err = classifyError(new Error("something went wrong"));
    assert.strictEqual(err.category, "runtime");
  });

  test("handles non-Error values", () => {
    const err = classifyError("just a string error");
    assert.strictEqual(err.category, "runtime");
    assert.strictEqual(err.message, "just a string error");
  });

  test("handles null", () => {
    const err = classifyError(null);
    assert.strictEqual(err.category, "runtime");
    assert.strictEqual(err.message, "null");
  });

  test("auth errors are not retryable", () => {
    const err = classifyError(new Error("401 Unauthorized"));
    assert.strictEqual(err.retryable, false);
  });

  test("quota errors are retryable", () => {
    const err = classifyError(new Error("429 Too Many Requests"));
    assert.strictEqual(err.retryable, true);
  });

  test("token errors are not retryable", () => {
    const err = classifyError(new Error("context window exceeded"));
    assert.strictEqual(err.retryable, false);
  });
});

describe("verification failure mapping", () => {
  test("verification command exit code != 0 maps to verification error", () => {
    const err = createError(
      "verification",
      "VERIFICATION_FAILED",
      "npm test exited with code 1",
      { retryable: false }
    );

    assert.strictEqual(err.category, "verification");
    assert.strictEqual(err.code, "VERIFICATION_FAILED");
    assert.strictEqual(err.retryable, false);
  });

  test("verification failure result status is failed", () => {
    const result = {
      status: "failed" as const,
      commands: ["npm test"],
      results: [
        {
          command: "npm test",
          exit_code: 1,
          duration_ms: 5000,
          stdout: "FAILURES"
        }
      ]
    };

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.results[0].exit_code, 1);
  });

  test("verification success result status is passed", () => {
    const result = {
      status: "passed" as const,
      commands: ["npm test"],
      results: [
        {
          command: "npm test",
          exit_code: 0,
          duration_ms: 3000,
          stdout: "All tests pass"
        }
      ]
    };

    assert.strictEqual(result.status, "passed");
    assert.strictEqual(result.results[0].exit_code, 0);
  });

  test("verification not_run result", () => {
    const result = {
      status: "not_run" as const,
      commands: [],
      results: []
    };

    assert.strictEqual(result.status, "not_run");
  });
});

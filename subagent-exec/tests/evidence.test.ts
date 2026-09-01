import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractAcceptanceEvidence } from "../src/evidence.js";

describe("structured acceptance evidence", () => {
  test("parses reproducible evidence and preserves review fields", () => {
    const value = extractAcceptanceEvidence(`done\n\`\`\`subagent-evidence
{"assumptions":["A"],"decisions":["D"],"criteria":[{"criterion":"tests pass","status":"passed","evidence":[{"type":"command","reference":"npm test"}]}],"changed_symbols":["run"],"tests_added":["evidence.test.ts"],"known_risks":[],"unresolved_items":[],"review_locations":["src/evidence.ts:1"],"recommended_next_action":"review diff"}
\`\`\``, ["tests pass"], { verification: { status: "passed", commands: ["npm test"], results: [{ command: "npm test", exit_code: 0, duration_ms: 1 }] } });
    assert.equal(value.criteria[0].status, "passed");
    assert.equal(value.criteria[0].evidence[0].reference, "npm test");
    assert.deepEqual(value.changed_symbols, ["run"]);
  });

  test("downgrades unsupported passed claims to manual review", () => {
    const value = extractAcceptanceEvidence(`\`\`\`subagent-evidence
{"criteria":[{"criterion":"looks good","status":"passed","evidence":[]}]}
\`\`\``, ["looks good", "missing"]);
    assert.deepEqual(value.criteria.map((item) => item.status), ["manual_review_required", "manual_review_required"]);
  });

  test("invalid or absent evidence marks every criterion for manual review", () => {
    assert.deepEqual(extractAcceptanceEvidence("plain response", ["a"]).criteria[0], {
      criterion: "a", status: "manual_review_required", evidence: []
    });
  });

  test("validates command, test, file, and symbol references against execution facts", () => {
    const criteria = ["command", "test", "file", "symbol", "fake"];
    const block = {
      criteria: [
        { criterion: "command", status: "passed", evidence: [{ type: "command", reference: "npm test" }] },
        { criterion: "test", status: "passed", evidence: [{ type: "test", reference: "specific test passed" }] },
        { criterion: "file", status: "passed", evidence: [{ type: "file", reference: "src/a.ts:10" }] },
        { criterion: "symbol", status: "passed", evidence: [{ type: "symbol", reference: "src/a.ts#run" }] },
        { criterion: "fake", status: "passed", evidence: [{ type: "file", reference: "missing.ts:1" }] }
      ]
    };
    const value = extractAcceptanceEvidence(`\`\`\`subagent-evidence\n${JSON.stringify(block)}\n\`\`\``, criteria, {
      verification: { status: "passed", commands: ["npm test"], results: [{ command: "npm test", exit_code: 0, duration_ms: 1, stdout: "specific test passed" }] },
      changedFiles: ["src/a.ts"]
    });
    assert.deepEqual(value.criteria.map((item) => item.status), ["passed", "passed", "passed", "passed", "manual_review_required"]);
  });

  test("accepts only a single evidence block at the end of the response", () => {
    const old = `\`\`\`subagent-evidence\n{"criteria":[]}\n\`\`\``;
    assert.equal(extractAcceptanceEvidence(`${old}\nmore text`, ["a"]).criteria[0].status, "manual_review_required");
    const corrected = `\`\`\`subagent-evidence\n{"criteria":[{"criterion":"a","status":"failed","evidence":[]}]}\n\`\`\``;
    assert.equal(extractAcceptanceEvidence(`${old}\n${corrected}`, ["a"]).criteria[0].status, "manual_review_required");
  });

  test("rejects empty symbols, invalid file lines, and test substrings", () => {
    const criteria = ["symbol", "file", "test"];
    const block = { criteria: [
      { criterion: "symbol", status: "passed", evidence: [{ type: "symbol", reference: "src/a.ts#" }] },
      { criterion: "file", status: "passed", evidence: [{ type: "file", reference: "src/a.ts:not-a-line" }] },
      { criterion: "test", status: "passed", evidence: [{ type: "test", reference: "pass" }] }
    ] };
    const value = extractAcceptanceEvidence(`\`\`\`subagent-evidence\n${JSON.stringify(block)}\n\`\`\``, criteria, {
      verification: { status: "passed", commands: ["npm test"], results: [{ command: "npm test", exit_code: 0, duration_ms: 1, stdout: "specific test passed" }] },
      changedFiles: ["src/a.ts"]
    });
    assert.deepEqual(value.criteria.map((item) => item.status), ["manual_review_required", "manual_review_required", "manual_review_required"]);
  });
});

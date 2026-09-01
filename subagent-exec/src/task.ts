import { z } from "zod";

import type { Task, ContinueTask } from "./types.js";

/**
 * Zod schema for Task Contract validation.
 *
 * Required fields: schema_version, task_id, prompt
 * Optional fields: objective, cwd, scope, allowed_paths, constraints,
 *                  acceptance_criteria, verification, iteration, model,
 *                  timeout_ms, metadata
 */
const TaskSchema = z.object({
  schema_version: z.literal("1.0"),

  task_id: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^[A-Za-z0-9._:-]+$/,
      "task_id must match ^[A-Za-z0-9._:-]+$, max 200 chars"
    ),

  task_class: z.enum(["mechanical_refactoring", "test_generation", "bug_investigation", "small_feature", "cross_module", "other"]).optional(),

  // Keeps delegated work packets bounded enough to review and retry safely.
  prompt: z.string().min(1).max(12_000),

  objective: z.string().optional(),

  cwd: z.string().min(1).optional(),

  scope: z.enum(["read_only", "read_write"]).optional(),

  allowed_paths: z
    .array(z.string().min(1))
    .optional(),

  constraints: z
    .array(z.string().min(1))
    .optional(),

  acceptance_criteria: z
    .array(z.string().min(1))
    .refine((items) => new Set(items).size === items.length, "acceptance_criteria must be unique")
    .optional(),

  verification: z
    .object({
      commands: z
        .array(z.string().min(1))
        .optional(),

      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
    })
    .optional(),

  iteration: z
    .object({
      max_iterations: z
        .number()
        .int()
        .positive()
        .max(3)
        .optional()
    })
    .optional(),

  execution_policy: z.object({
    mode: z.enum(["fast", "checkpoint", "investigation"]),
    risk: z.enum(["low", "medium", "high"]),
    max_changed_files: z.number().int().positive().optional(),
    max_diff_lines: z.number().int().positive().optional(),
    allow_binary_changes: z.boolean().optional(),
    estimated_direct_cost_usd: z.number().positive().optional(),
    max_cost_ratio: z.number().positive().max(1).optional(),
    on_failure: z.literal("return_to_coordinator")
  }).optional(),

  model: z
    .object({
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional()
    })
    .optional(),

  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional(),

  metadata: z
    .record(z.string(), z.unknown())
    .optional()
});

const ContinueTaskSchema = z.object({
  schema_version: z.literal("1.0"),

  task_id: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^[A-Za-z0-9._:-]+$/,
      "task_id must match ^[A-Za-z0-9._:-]+$"
    ),

  action: z.literal("continue"),

  feedback: z.string().min(1),

  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional(),

  metadata: z
    .record(z.string(), z.unknown())
    .optional()
});

export function parseTask(value: unknown): Task {
  return TaskSchema.parse(value) as Task;
}

export function parseContinueTask(value: unknown): ContinueTask {
  return ContinueTaskSchema.parse(value) as ContinueTask;
}

/**
 * Build the prompt string sent to the worker.
 *
 * Sections are emitted in a fixed order so the worker can parse them
 * reliably. Each section is clearly labelled so it cannot be confused
 * with user content.
 */
export function buildWorkerPrompt(
  prompt: string,
  constraints?: string[],
  acceptance_criteria?: string[]
): string {
  const parts: string[] = [prompt];

  if (constraints && constraints.length > 0) {
    parts.push("");
    parts.push("### CONSTRAINTS");
    for (const c of constraints) {
      parts.push(`- ${c}`);
    }
  }

  if (
    acceptance_criteria &&
    acceptance_criteria.length > 0
  ) {
    parts.push("");
    parts.push("### ACCEPTANCE CRITERIA");
    for (const a of acceptance_criteria) {
      parts.push(`- ${a}`);
    }
  }

  parts.push("");
  parts.push("### STRUCTURED ACCEPTANCE EVIDENCE");
  parts.push("End your response with a fenced `subagent-evidence` JSON object containing: assumptions, decisions, criteria (criterion, status, evidence), changed_symbols, tests_added, known_risks, unresolved_items, review_locations, recommended_next_action, and optional handoff {type: architecture|requirement, reason}. Evidence entries use type command|test|file|symbol plus a concrete reference. Use manual_review_required when a criterion lacks reproducible evidence; use handoff when coordinator judgment is required instead of claiming success.");

  return parts.join("\n");
}

/**
 * Build the feedback prompt sent on a continuation round.
 *
 * Wraps Codex's review feedback so the worker can distinguish it
 * from the original task description.
 */
export function buildContinuePrompt(
  feedback: string,
  iteration: number,
  lastSummary?: string
): string {
  const parts: string[] = [];

  parts.push(
    `### REVIEW FEEDBACK (iteration ${iteration})`
  );
  parts.push("");
  parts.push(feedback);

  if (lastSummary) {
    parts.push("");
    parts.push("### YOUR PREVIOUS SUMMARY");
    parts.push("");
    parts.push(lastSummary);
  }

  parts.push("");
  parts.push("Apply the feedback above and re-run your verification.");
  parts.push(
    "When done, summarize only what changed in this iteration."
  );

  return parts.join("\n");
}

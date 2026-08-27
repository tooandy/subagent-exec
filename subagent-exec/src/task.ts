import { z } from "zod";

import type { Task } from "./types.js";

/**
 * Zod schema for Task Contract validation.
 *
 * Required fields: schema_version, task_id, prompt
 * Optional fields: objective, cwd, scope, allowed_paths, constraints,
 *                  acceptance_criteria, verification, model, timeout_ms, metadata
 *
 * This schema must stay in sync with the TypeScript Task interface
 * in types.ts and the CONTRACT.md specification.
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

  prompt: z.string().min(1),

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
    .record(
      z.string(),
      z.unknown()
    )
    .optional()
});

export function parseTask(
  value: unknown
): Task {
  return TaskSchema.parse(value) as Task;
}

/**
 * Build the prompt string sent to the worker.
 *
 * Sections are emitted in a fixed order so the worker can parse them
 * reliably.  Each section is clearly labelled so it cannot be confused
 * with user content.
 *
 * @param prompt   The raw task prompt
 * @param constraints  Optional implementation constraints
 * @param acceptance_criteria  Optional acceptance criteria
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

  if (acceptance_criteria && acceptance_criteria.length > 0) {
    parts.push("");
    parts.push("### ACCEPTANCE CRITERIA");
    for (const c of acceptance_criteria) {
      parts.push(`- ${c}`);
    }
  }

  return parts.join("\n");
}

import { z } from "zod";

import type { Task } from "./types.js";

const TaskSchema = z.object({
  schema_version: z.literal("1.0"),

  task_id: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^[A-Za-z0-9._:-]+$/
    ),

  objective: z.string().min(1),

  prompt: z.string().min(1),

  cwd: z.string().min(1).optional(),

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
    .max(
      24 * 60 * 60 * 1000
    )
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

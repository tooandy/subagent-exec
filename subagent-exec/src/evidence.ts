import { z } from "zod";
import type { AcceptanceEvidence, VerificationResult } from "./types.js";

const EvidenceSchema = z.object({
  assumptions: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  criteria: z.array(z.object({
    criterion: z.string().min(1),
    status: z.enum(["passed", "failed", "manual_review_required"]),
    evidence: z.array(z.object({
      type: z.enum(["command", "test", "file", "symbol"]),
      reference: z.string().min(1),
      detail: z.string().optional()
    })).default([])
  })).default([]),
  changed_symbols: z.array(z.string()).default([]),
  tests_added: z.array(z.string()).default([]),
  known_risks: z.array(z.string()).default([]),
  unresolved_items: z.array(z.string()).default([]),
  review_locations: z.array(z.string()).default([]),
  recommended_next_action: z.string().min(1).optional()
});

function empty(criteria: string[]): AcceptanceEvidence {
  return {
    assumptions: [], decisions: [],
    criteria: criteria.map((criterion) => ({ criterion, status: "manual_review_required", evidence: [] })),
    changed_symbols: [], tests_added: [], known_risks: [], unresolved_items: [], review_locations: []
  };
}

export interface EvidenceContext {
  verification?: VerificationResult;
  changedFiles?: string[];
}

export function extractAcceptanceEvidence(message: string | undefined, required: string[] = [], context: EvidenceContext = {}): AcceptanceEvidence {
  if (!message) return empty(required);
  const match = message.match(/```subagent-evidence\s*([\s\S]*?)```\s*$/i);
  if (!match) return empty(required);
  try {
    const parsed = EvidenceSchema.parse(JSON.parse(match[1])) as AcceptanceEvidence;
    const byCriterion = new Map(parsed.criteria.map((item) => [item.criterion, item]));
    parsed.criteria = required.map((criterion) => {
      const item = byCriterion.get(criterion);
      if (!item) return { criterion, status: "manual_review_required" as const, evidence: [] };
      const evidence = item.evidence.filter((entry) => isReproducible(entry, context));
      if (item.status === "passed" && evidence.length === 0) {
        return { ...item, status: "manual_review_required" as const, evidence };
      }
      return { ...item, evidence };
    });
    return parsed;
  } catch {
    return empty(required);
  }
}

function isReproducible(entry: AcceptanceEvidence["criteria"][number]["evidence"][number], context: EvidenceContext): boolean {
  const reference = entry.reference.trim();
  if (!reference) return false;
  const successful = context.verification?.results.filter((result) => result.exit_code === 0) ?? [];
  if (entry.type === "command") return successful.some((result) => result.command === reference);
  if (entry.type === "test") return successful.some((result) =>
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/).some((line) => line.trim() === reference)
  );
  if (entry.type === "symbol") {
    const hash = reference.lastIndexOf("#");
    if (hash <= 0) return false;
    const path = reference.slice(0, hash).trim();
    const symbol = reference.slice(hash + 1).trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$.:<>-]*$/.test(symbol)) return false;
    return (context.changedFiles ?? []).includes(path);
  }
  const colon = reference.lastIndexOf(":");
  const hasLine = colon > 0;
  const path = (hasLine ? reference.slice(0, colon) : reference).trim();
  if (hasLine && !/^[1-9][0-9]*$/.test(reference.slice(colon + 1))) return false;
  return (context.changedFiles ?? []).includes(path);
}

# subagent-exec Roadmap

## Product direction

`subagent-exec` should be a controlled execution runtime for bounded,
machine-verifiable tasks. Its goal is not to delegate every coding task or to
assume that a cheaper worker always saves tokens.

The runtime should reduce coordinator cost when:

- the task has a clear scope and acceptance criteria;
- correctness can be checked automatically;
- execution work is larger than the orchestration and review overhead;
- a failed attempt has a small, reversible blast radius;
- the worker can return compact, structured review evidence.

The runtime should reject implementation delegation, or use read-only
investigation, when requirements are ambiguous, architecture decisions are
unresolved, verification is subjective, or recovery would be expensive.

## Phase 1: Stabilize session continuation

Complete the current continuation implementation before adding cost scoring or
more execution modes.

### Scope

- Make `iteration.max_iterations` the single source of truth across the Zod
  schema, TypeScript types, persisted metadata, and runtime enforcement.
- Preserve the original verification configuration across continuation rounds.
- Capture and persist the exact Pi session identifier; never resume a task by
  relying only on the most recent session in a shared directory.
- Separate runtime metadata from Pi session files.
- Keep `.subagent-exec/` out of version control and document its lifecycle.
- Use atomic session metadata writes and validate loaded metadata.
- Remove stale or contradictory `stateless` terminology where continuation is
  supported.
- Keep continuation bounded to two rounds by default and three at most unless
  there is an explicit, validated reason for a higher limit.

### Tests

- Unit tests for `parseContinueTask` and `buildContinuePrompt`.
- Unit tests for session creation, save/load, corrupt data, and atomic updates.
- Tests proving that iteration limits are enforced from `iteration`, not
  arbitrary metadata.
- Tests proving that verification commands and task constraints survive a
  continuation.
- Integration tests for start, continue, missing session, exact session resume,
  interleaved tasks, timeout, cancellation, and failed verification.
- CLI wrapper tests for missing, conflicting, and repeated arguments.

### Exit criteria

- Interleaved tasks cannot resume each other's worker session.
- Every continuation runs the original runtime verification unless explicitly
  overridden by a future contract version.
- Schema, types, runtime behavior, README, skill instructions, and contract
  documentation agree.
- All existing and new tests pass.

## Phase 2: Delegation admission policy

Add a small, deterministic admission gate before introducing a complex scoring
model.

Implementation tasks should normally require:

- non-empty `allowed_paths`;
- explicit `acceptance_criteria`;
- repeatable `verification.commands`;
- a bounded, self-contained prompt;
- a declared risk level and change budget.

Introduce an `execution_policy` contract similar to:

```json
{
  "execution_policy": {
    "risk": "medium",
    "max_changed_files": 5,
    "max_diff_lines": 500,
    "on_failure": "return_to_coordinator"
  }
}
```

Support three initial modes:

1. **Fast** — one implementation attempt for low-risk, mechanical work.
2. **Checkpoint** — short plan gate followed by one coordinator-approved
   implementation round for medium-risk work.
3. **Investigation** — read-only evidence gathering for ambiguous or high-risk
   work; the coordinator owns the implementation decision.

Return `DELEGATION_NOT_RECOMMENDED` when a requested implementation does not
meet its admission requirements.

Iteration limits remain owned by `iteration.max_iterations`: Fast requires 1,
Checkpoint requires 2, and Investigation requires 1.

### Phase 2 exit criteria

- Inadmissible tasks are rejected before a Worker process is spawned.
- Fast accepts only bounded low-risk, single-round implementation tasks.
- Checkpoint produces a read-only first-round plan and requires coordinator
  continuation before its implementation round.
- Investigation is high-risk, single-round, and read-only.
- File-count and diff-line budgets reject oversized implementation results.
- Contract documentation and automated tests cover all modes and rejection
  reasons.

## Phase 3: Structured acceptance evidence

Optimize the Result Contract for cheap, reliable review instead of longer
natural-language summaries.

Add structured fields for:

- assumptions and decisions;
- each acceptance criterion, its status, and concrete evidence;
- changed symbols and tests added;
- known risks and unresolved items;
- locations that require coordinator review;
- a recommended next action on failure.

Evidence should reference reproducible commands, test names, and file or symbol
locations. Criteria without machine-verifiable evidence must be marked
`manual_review_required`, not silently treated as passed.

### Phase 3 exit criteria

- Every Result contains a schema-stable `acceptance_evidence` object.
- Every requested acceptance criterion appears exactly once; unsupported
  passed claims require manual review.
- Evidence identifies commands, tests, files, and symbols with concrete
  references.
- Assumptions, decisions, changed symbols, tests, risks, unresolved items,
  review locations, and a recommended next action survive into the Result.
- Contract, coordinator guidance, unit tests, and CLI integration tests agree.

## Phase 4: Rework circuit breaker

Continuation is a bounded repair mechanism, not a default retry loop.

Initial stop rules:

- stop immediately on a scope violation;
- stop when the same failure class occurs twice;
- stop when a repair attempt adds no new diagnostic evidence;
- return architecture or requirement errors to the coordinator instead of
  continuing the same session;
- stop when the worker budget reaches a configured fraction of estimated direct
  execution cost;
- archive or delete session state after success or terminal failure.

The runtime state machine should distinguish:

```text
accepted -> running -> verifying -> success
                              \-> repairable_failure -> continuing
any state -> scope_violation | budget_exceeded | repeated_failure
          -> coordinator_required
```

Checkpoint tasks may declare three iterations in this phase: plan,
implementation, and one bounded repair. Two-iteration Checkpoints remain valid
when no repair budget is desired.

### Phase 4 exit criteria

- Results expose a deterministic continuation state and failure class.
- Scope, change/cost budget, architecture, requirement, and non-retryable
  runtime failures require immediate coordinator takeover.
- A Checkpoint permits at most one repair; repeated failure classes or
  unchanged diagnostic evidence open the circuit.
- Worker cost can be capped as a fraction of estimated direct-execution cost.
- Successful and terminal sessions are archived; only repairable or
  checkpoint-review sessions remain active.
- Contract, guidance, and tests cover every stop rule and lifecycle transition.

## Phase 5: Isolated candidate changes

Run write-capable workers in an isolated Git worktree or equivalent disposable
workspace.

The worker should produce a candidate patch that passes:

- allowed-path checks;
- file-count and diff-size budgets;
- configured verification;
- structured acceptance evidence validation.

Only then should the coordinator review and accept the patch. Failed or rejected
attempts must be disposable without modifying the user's working tree.

### Phase 5 exit criteria

- Every write-capable Worker runs in a detached disposable Git worktree.
- Scope, budgets, verification, and evidence are evaluated in that worktree.
- Worker and verification subprocess writes are OS-contained to the candidate
  and task session storage; unsupported platforms fail closed.
- A successful candidate exports a binary-capable patch while the main working
  tree remains unchanged.
- Binary candidates require explicit policy opt-in, and candidate symlinks may
  not resolve outside the disposable worktree.
- Terminal failures discard their worktree; repairable failures retain it for
  the one bounded continuation.
- Applying a candidate requires an explicit coordinator command that first
  verifies the recorded base commit and clean affected paths, performs
  `git apply --check`, and cannot apply the same patch twice.
- Contract, guidance, and integration tests cover accept, reject, repair, and
  conflict behavior.

## Phase 6: Cost and outcome measurement

Measure whether delegation saves coordinator effort instead of assuming it does.

Record at least:

- total worker tokens and cost;
- attempt and iteration counts;
- first-pass and final verification outcomes;
- scope violations;
- coordinator acceptance or rejection;
- files subsequently reworked by the coordinator;
- elapsed time to accepted result;
- terminal failure reason;
- delegation outcome: `saved`, `neutral`, or `amplified`.

Evaluate results by task class, such as mechanical refactoring, test generation,
bug investigation, small feature implementation, and cross-module work. Use
observed results to tune admission rules and budgets.

### Phase 6 exit criteria

- Every completed round atomically updates a per-task outcome record under
  `.subagent-exec/outcomes/` with cumulative tokens, cost, attempts, iteration,
  verification, scope, elapsed time, and terminal reason.
- Task contracts may declare a stable `task_class` for cohort analysis.
- Accept and reject commands record the coordinator decision; acceptance stores
  file fingerprints and initially remains `neutral` pending observation.
- `--assess-outcome <task_id>` compares accepted fingerprints with the current
  checkout and classifies no rework as `saved`, partial rework as `neutral`, and
  complete rework or rejection/terminal failure as `amplified`.
- Contract, guidance, and tests cover successful acceptance, rejection, token
  aggregation, and subsequent coordinator rework.

## Current implementation status

Phases 1–6 are implemented and independently reviewed. The next milestone is
operational calibration: collect outcome records across real task classes, then
tune admission thresholds and cost/change budgets from observed saved, neutral,
and amplified cohorts without weakening the fail-closed boundaries above.

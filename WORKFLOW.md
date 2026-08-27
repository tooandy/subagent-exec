# Worker Workflow Patterns

How to decompose a task into `subagent-exec` worker invocations.

These patterns are guidance for Codex, not rules. Pick the simplest
pattern that fits the task; do not over-decompose.

---

## Pattern 1: Implement + Review

The most common pattern.

```
Codex:
  1. Analyze requirement.
  2. Delegate implementation.
  3. Review worker result.
  4. Run integration validation.
```

Use when:

- The implementation is well-bounded.
- Acceptance criteria are clear.
- No major architectural decision is involved.

Example: implement a specific function or class.

## Pattern 2: Investigate + Implement

Useful when the root cause is unknown.

```
Worker A: investigate root cause
Codex:    review investigation
Worker B: implement fix
Codex:    validate
```

Use when:

- A bug has been reproduced but not localized.
- A change has unexpected behavior and the cause is unclear.
- Multiple plausible hypotheses need to be ruled out.

## Pattern 3: Parallel Implementation

Independent work streams.

```
Worker A: backend
Worker B: tests
Worker C: documentation
```

Use when:

- File scopes do not overlap.
- Tasks have no inter-dependencies.
- Wall-clock time matters.

Constraints:

- Each worker must have a non-overlapping `allowed_paths`.
- Codex must reconcile the parallel results and run integration tests.

## Pattern 4: Worker as Reviewer

The worker inspects implementation; Codex remains the final reviewer.

```
Codex:  implement or delegate implementation
Worker: focused code review (read-only)
Codex:  incorporate review, finalize
```

Use when:

- The change is large enough that an independent perspective helps.
- The implementation has subtle correctness / style concerns.

The worker prompt should:

- Be read-only (set `allowed_paths: []`).
- Require a structured review (strengths, weaknesses, suggestions).

## Pattern 5: Test-Only Delegation

Worker runs and diagnoses tests.

```
Codex:  identify failing tests
Worker: run tests, analyze failures, propose minimal fixes
Codex:  decide whether to apply fixes
```

Use when:

- Tests are flaky or slow.
- The failure mode needs investigation.

## Pattern 6: Documentation Generation

```
Codex:  identify documentation surface
Worker: generate docs from code, update README / comments
Codex:  review and merge
```

Use when:

- The code is stable and documentation is lagging.
- The doc style is well-defined and constrained by examples.

## Pattern 7: Refactor

```
Codex:  identify refactor scope
Worker: perform mechanical refactor (rename, extract, etc.)
Codex:  run full test suite, review diff
```

Use when:

- The refactor is mechanical and well-defined.
- The behavior must not change.

Always require Codex to run integration tests after.

---

## Anti-patterns

These patterns usually waste time or money.

### Delegating open-ended tasks

> "Improve the codebase."

Too vague. Decompose first.

### Delegating architecture decisions

> "Decide how to structure the new service."

This is Codex's job. The worker is an executor.

### Skipping the review

> "Worker reported completed. Done."

Always review. Worker output is evidence, not truth.

### Retrying identical failed tasks

> Same task, same prompt, same scope.

Add information or narrow scope before retrying.

### Over-decomposition

> 10 micro-tasks of 1-line edits each.

Each invocation has overhead. Decompose only when it actually helps.

---

## Cost-Aware Decomposition

A rough budget heuristic:

- Codex reasoning: expensive (1 unit)
- Worker reasoning: cheap (0.05 unit)
- Worker invocation overhead: ~0.01 unit + a few seconds

So:

- Decompose if total worker cost < Codex cost
- Don't decompose if the decomposition itself requires Codex reasoning
- Parallelize only if wall-clock matters AND tasks are independent

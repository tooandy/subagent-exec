import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  captureBaseline,
  checkScope,
  countDiffLines,
  type WorkspaceBaseline
} from "../src/workspace.js";

describe("countDiffLines", () => {
  test("counts unstaged, staged, and untracked text changes", async () => {
    const repo = await initRepo();
    try {
      await makeFile(repo.dir, "tracked.txt", "one\n");
      await commitAll(repo.dir, "init");
      await writeFile(join(repo.dir, "tracked.txt"), "one\ntwo\n");
      await makeFile(repo.dir, "staged.txt", "a\nb\n");
      execFileSync("git", ["add", "staged.txt"], { cwd: repo.dir });
      await makeFile(repo.dir, "untracked.txt", "x\ny\n");
      const count = await countDiffLines(repo.dir, ["tracked.txt", "staged.txt", "untracked.txt"]);
      assert.ok(count >= 5);
    } finally { await repo.cleanup(); }
  });

  test("treats binary changes as over any practical line budget", async () => {
    const repo = await initRepo();
    try {
      await writeFile(join(repo.dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      execFileSync("git", ["add", "binary.bin"], { cwd: repo.dir });
      await commitAll(repo.dir, "binary");
      await writeFile(join(repo.dir, "binary.bin"), Buffer.from([0, 9, 8, 7]));
      assert.equal(await countDiffLines(repo.dir, ["binary.bin"]), Number.MAX_SAFE_INTEGER);
    } finally { await repo.cleanup(); }
  });

  test("treats an untracked binary as over budget", async () => {
    const repo = await initRepo();
    try {
      await makeFile(repo.dir, "seed.txt", "seed\n");
      await commitAll(repo.dir, "init");
      await writeFile(join(repo.dir, "new.bin"), Buffer.from([0, 1, 2, 3]));
      assert.equal(await countDiffLines(repo.dir, ["new.bin"]), Number.MAX_SAFE_INTEGER);
    } finally { await repo.cleanup(); }
  });

  test("counts only worker changes to a pre-existing dirty file", async () => {
    const repo = await initRepo();
    try {
      await makeFile(repo.dir, "tracked.txt", "base\n");
      await commitAll(repo.dir, "init");
      await writeFile(join(repo.dir, "tracked.txt"), `base\n${Array.from({ length: 20 }, (_, i) => `user-${i}`).join("\n")}\n`);
      const baseline = await captureBaseline(repo.dir);
      await writeFile(join(repo.dir, "tracked.txt"), `base\n${Array.from({ length: 20 }, (_, i) => `user-${i}`).join("\n")}\nworker\n`);
      assert.equal(await countDiffLines(repo.dir, ["tracked.txt"], baseline), 1);
    } finally { await repo.cleanup(); }
  });
});

// =============================================================================
// workspace.ts — integration tests against real temporary git repositories.
//
// We do NOT reimplement parsePorcelain / classifyChanges / etc. here.
// Instead we drive the real captureBaseline / checkScope against a real
// git repo and assert on its outputs. This keeps tests honest.
// =============================================================================

interface Repo {
  dir: string;
  cleanup: () => Promise<void>;
}

async function initRepo(): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), "subagent-exec-test-"));

  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function git(
  cwd: string,
  args: string[]
): Promise<string> {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  }).trim();
}

async function commitAll(cwd: string, message: string) {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", message, "--quiet"]);
}

async function makeFile(cwd: string, relPath: string, content: string) {
  const full = join(cwd, relPath);
  const dir = full.substring(0, full.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(full, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("captureBaseline — clean repo", () => {
  let repo: Repo;
  let baseline: WorkspaceBaseline;

  before(async () => {
    repo = await initRepo();
    await makeFile(repo.dir, "src/a.ts", "a");
    await makeFile(repo.dir, "src/b.ts", "b");
    await commitAll(repo.dir, "init");

    baseline = await captureBaseline(repo.dir);
  });

  after(async () => {
    await repo.cleanup();
  });

  test("captures no dirty paths on a clean repo", () => {
    assert.strictEqual(baseline.dirtyPaths.size, 0);
  });

  test("returns fingerprints map (possibly empty)", () => {
    assert.ok(baseline.fingerprints instanceof Map);
  });
});

describe("captureBaseline — repo with pre-existing dirty files", () => {
  let repo: Repo;
  let baseline: WorkspaceBaseline;

  before(async () => {
    repo = await initRepo();
    await makeFile(repo.dir, "src/clean.ts", "clean content");
    await makeFile(repo.dir, "src/dirty.ts", "dirty content");
    await commitAll(repo.dir, "init");

    // Make src/dirty.ts dirty (uncommitted modification).
    await writeFile(
      join(repo.dir, "src/dirty.ts"),
      "dirty content MODIFIED BY USER"
    );

    baseline = await captureBaseline(repo.dir);
  });

  after(async () => {
    await repo.cleanup();
  });

  test("captures pre-existing dirty paths", () => {
    assert.ok(baseline.dirtyPaths.has("src/dirty.ts"));
    assert.ok(!baseline.dirtyPaths.has("src/clean.ts"));
  });

  test("captures fingerprints for dirty files", () => {
    assert.ok(baseline.fingerprints.has("src/dirty.ts"));
    // The fingerprint for the dirty file should differ from the
    // committed version.
    const fingerprint = baseline.fingerprints.get("src/dirty.ts");
    assert.ok(fingerprint, "fingerprint should be set");
    assert.notStrictEqual(fingerprint, "");
  });
});

describe("checkScope — read_write mode", () => {
  let repo: Repo;

  before(async () => {
    repo = await initRepo();
    await makeFile(repo.dir, "src/clean.ts", "clean");
    await makeFile(repo.dir, "src/foo.ts", "foo");
    await makeFile(repo.dir, "src/bar.ts", "bar");
    await commitAll(repo.dir, "init");
  });

  after(async () => {
    await repo.cleanup();
  });

  test("read_write + empty allowed_paths → status not_checked", async () => {
    const baseline = await captureBaseline(repo.dir);
    await writeFile(join(repo.dir, "src/foo.ts"), "foo MODIFIED");

    const scope = await checkScope(
      repo.dir,
      baseline,
      [],
      "read_write"
    );

    assert.strictEqual(scope.status, "not_checked");
    assert.strictEqual(scope.scope_mode, "read_write");
    assert.ok(scope.changed_files.includes("src/foo.ts"));
  });

  test("read_write + allowed_paths that include change → passed", async () => {
    const baseline = await captureBaseline(repo.dir);
    await writeFile(join(repo.dir, "src/foo.ts"), "foo MODIFIED");

    const scope = await checkScope(
      repo.dir,
      baseline,
      ["src/foo.ts"],
      "read_write"
    );

    assert.strictEqual(scope.status, "passed");
    assert.deepStrictEqual(scope.violations, []);
  });

  test("read_write + change outside allowed_paths → failed", async () => {
    const baseline = await captureBaseline(repo.dir);
    // Worker introduces a new change to foo.ts AFTER baseline.
    await writeFile(join(repo.dir, "src/foo.ts"), "foo MODIFIED BY WORKER");

    const scope = await checkScope(
      repo.dir,
      baseline,
      ["src/bar.ts"],
      "read_write"
    );

    assert.strictEqual(scope.status, "failed");
    assert.strictEqual(scope.violations.length, 1);
    assert.strictEqual(scope.violations[0].path, "src/foo.ts");
  });
});

describe("checkScope — read_only mode", () => {
  let repo: Repo;

  before(async () => {
    repo = await initRepo();
    await makeFile(repo.dir, "src/foo.ts", "foo");
    await commitAll(repo.dir, "init");
  });

  after(async () => {
    await repo.cleanup();
  });

  test("read_only with no changes → passed", async () => {
    const baseline = await captureBaseline(repo.dir);

    const scope = await checkScope(
      repo.dir,
      baseline,
      [],
      "read_only"
    );

    assert.strictEqual(scope.status, "passed");
    assert.strictEqual(scope.violations.length, 0);
  });

  test("read_only with any change → failed", async () => {
    const baseline = await captureBaseline(repo.dir);
    await writeFile(join(repo.dir, "src/foo.ts"), "foo MODIFIED");

    const scope = await checkScope(
      repo.dir,
      baseline,
      [],
      "read_only"
    );

    assert.strictEqual(scope.status, "failed");
    assert.strictEqual(scope.violations.length, 1);
    assert.strictEqual(scope.violations[0].path, "src/foo.ts");
  });

  test("read_only with new untracked file → failed", async () => {
    const baseline = await captureBaseline(repo.dir);
    await writeFile(join(repo.dir, "new.ts"), "new");

    const scope = await checkScope(
      repo.dir,
      baseline,
      [],
      "read_only"
    );

    assert.strictEqual(scope.status, "failed");
    assert.ok(
      scope.violations.some((v) => v.path === "new.ts")
    );
  });
});

describe("checkScope — pre-existing dirty file modified again", () => {
  let repo: Repo;

  before(async () => {
    repo = await initRepo();
    await makeFile(repo.dir, "src/dirty.ts", "original");
    await commitAll(repo.dir, "init");

    // Pre-existing dirty state.
    await writeFile(join(repo.dir, "src/dirty.ts"), "user edit");
  });

  after(async () => {
    await repo.cleanup();
  });

  test("worker modifies pre-existing dirty file → still detected", async () => {
    const baseline = await captureBaseline(repo.dir);

    // Worker overwrites the dirty file.
    await writeFile(
      join(repo.dir, "src/dirty.ts"),
      "worker overwrote the user's edit"
    );

    const scope = await checkScope(
      repo.dir,
      baseline,
      ["src/dirty.ts"],
      "read_write"
    );

    // The fingerprint must have changed; the worker introduced
    // new content even though the file was already dirty.
    assert.ok(
      scope.changed_files.includes("src/dirty.ts"),
      "worker modification of pre-dirty file must be detected"
    );
  });

  test("worker does not touch pre-existing dirty file → no change reported", async () => {
    const baseline = await captureBaseline(repo.dir);

    // Worker makes a change elsewhere.
    await writeFile(join(repo.dir, "src/new.ts"), "new content");

    const scope = await checkScope(
      repo.dir,
      baseline,
      ["src/**"],
      "read_write"
    );

    assert.ok(scope.changed_files.includes("src/new.ts"));
    assert.ok(!scope.changed_files.includes("src/dirty.ts"));
  });
});

describe("checkScope — change classification", () => {
  let repo: Repo;

  before(async () => {
    repo = await initRepo();
    await makeFile(repo.dir, "src/existing.ts", "existing");
    await commitAll(repo.dir, "init");
  });

  after(async () => {
    await repo.cleanup();
  });

  test("new file appears in added_files", async () => {
    const baseline = await captureBaseline(repo.dir);
    await writeFile(join(repo.dir, "src/added.ts"), "new");

    const scope = await checkScope(
      repo.dir,
      baseline,
      ["src/**"],
      "read_write"
    );

    assert.ok(scope.added_files.includes("src/added.ts"));
  });

  test("modified file appears in modified_files", async () => {
    const baseline = await captureBaseline(repo.dir);
    await writeFile(join(repo.dir, "src/existing.ts"), "modified");

    const scope = await checkScope(
      repo.dir,
      baseline,
      ["src/**"],
      "read_write"
    );

    assert.ok(scope.modified_files.includes("src/existing.ts"));
    assert.ok(!scope.added_files.includes("src/existing.ts"));
  });

  test("deleted file appears in deleted_files", async () => {
    const baseline = await captureBaseline(repo.dir);
    await rm(join(repo.dir, "src/existing.ts"));

    const scope = await checkScope(
      repo.dir,
      baseline,
      ["src/**"],
      "read_write"
    );

    assert.ok(scope.deleted_files.includes("src/existing.ts"));
  });
});

describe("captureBaseline — non-git directory", () => {
  let repo: Repo;

  before(async () => {
    repo = await initRepo();
    // captureBaseline requires a git repo; create one and then
    // verify error handling by checking what happens without one.
  });

  after(async () => {
    await repo.cleanup();
  });

  test("throws WorkspaceError when cwd is not a git repo", async () => {
    // Make a non-git temp dir.
    const tmpNoGit = await mkdtemp(join(tmpdir(), "no-git-"));
    try {
      await assert.rejects(
        () => captureBaseline(tmpNoGit),
        /not a git repository/i
      );
    } finally {
      await rm(tmpNoGit, { recursive: true, force: true });
    }
  });

  test("returns baseline for valid git repo", async () => {
    const baseline = await captureBaseline(repo.dir);
    assert.ok(baseline.dirtyPaths instanceof Set);
    assert.ok(baseline.fingerprints instanceof Map);
  });
});

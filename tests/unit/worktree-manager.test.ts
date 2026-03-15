#!/usr/bin/env npx jiti
/**
 * Unit tests for coordinate/worktree-manager.ts
 *
 * Tests:
 *   1. listWorktrees — returns empty array for non-git directory
 *   2. listWorktrees — returns at least the main repo path for a valid git repo
 *   3. createWorktree — returns handle with correct worktreePath and branch
 *   4. createWorktree — worktree directory exists on disk after creation
 *   5. createWorktree — new worktree appears in listWorktrees
 *   6. cleanup() — removes worktree and it no longer appears in listWorktrees
 *
 * Run: npx jiti tests/unit/worktree-manager.test.ts
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

import { TestRunner, assert, assertEqual, assertExists } from "../test-utils.js";
import { createWorktree, listWorktrees } from "../../coordinate/worktree-manager.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical temp dir (resolves macOS /var → /private/var symlink). */
async function realTmpDir(): Promise<string> {
	return fs.realpath(os.tmpdir());
}

/** Create a real temporary git repo with an initial commit. Returns dir and active branch name. */
async function makeTempGitRepo(): Promise<{ dir: string; mainBranch: string }> {
	const dir = await fs.mkdtemp(path.join(await realTmpDir(), "pi-wt-test-"));
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	await fs.writeFile(path.join(dir, "README.md"), "test repo");
	execSync("git add .", { cwd: dir, stdio: "pipe" });
	execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
	const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, stdio: "pipe" })
		.toString()
		.trim();
	return { dir, mainBranch };
}

async function cleanupRepo(dir: string): Promise<void> {
	try {
		try {
			execSync("git worktree prune", { cwd: dir, stdio: "pipe" });
		} catch {}
		await fs.rm(dir, { recursive: true, force: true });
	} catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();

	// ── TEST 1: listWorktrees — non-git directory ────────────────────────────
	runner.section("listWorktrees");

	await runner.test("returns empty array for a non-git directory", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-no-git-"));
		try {
			const result = await listWorktrees(tmpDir);
			assertEqual(result.length, 0, `Expected empty array for non-git dir, got ${JSON.stringify(result)}`);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// ── TEST 2: listWorktrees — valid git repo ────────────────────────────────
	await runner.test("returns at least the main repo path for a valid git repo", async () => {
		const { dir } = await makeTempGitRepo();
		try {
			const worktrees = await listWorktrees(dir);
			assert(worktrees.length >= 1, `Expected ≥1 worktree, got ${worktrees.length}`);
			assert(
				worktrees.some((p) => fsSync.existsSync(p)),
				`Expected at least one real path, got: ${JSON.stringify(worktrees)}`,
			);
		} finally {
			await cleanupRepo(dir);
		}
	});

	// ── TEST 3: createWorktree — handle shape ─────────────────────────────────
	runner.section("createWorktree");

	await runner.test("returns handle with correct worktreePath and branch", async () => {
		const { dir } = await makeTempGitRepo();
		const worktreeDir = path.join(await realTmpDir(), `pi-wt-handle-${Date.now()}`);
		try {
			// 'worker/test-1' must exist but not be currently checked out
			execSync("git branch worker/test-1", { cwd: dir, stdio: "pipe" });

			const handle = await createWorktree({
				repoDir: dir,
				branch: "worker/test-1",
				worktreeDir,
			});

			try {
				assertEqual(handle.branch, "worker/test-1", "branch must match");
				assertEqual(handle.worktreePath, worktreeDir, "worktreePath must match provided dir");
				assertExists(handle.cleanup, "cleanup function must exist");
				assertEqual(typeof handle.cleanup, "function", "cleanup must be a function");
			} finally {
				await handle.cleanup();
			}
		} finally {
			await cleanupRepo(dir);
			await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	// ── TEST 4: createWorktree — directory on disk ────────────────────────────
	await runner.test("worktree directory exists on disk after creation", async () => {
		const { dir } = await makeTempGitRepo();
		const worktreeDir = path.join(await realTmpDir(), `pi-wt-disk-${Date.now()}`);
		try {
			execSync("git branch worker/disk-test", { cwd: dir, stdio: "pipe" });

			const handle = await createWorktree({
				repoDir: dir,
				branch: "worker/disk-test",
				worktreeDir,
			});

			try {
				assert(
					fsSync.existsSync(worktreeDir),
					`Worktree directory should exist at ${worktreeDir}`,
				);
			} finally {
				await handle.cleanup();
			}
		} finally {
			await cleanupRepo(dir);
			await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	// ── TEST 5: createWorktree — appears in listWorktrees ────────────────────
	await runner.test("new worktree appears in listWorktrees after creation", async () => {
		const { dir } = await makeTempGitRepo();
		const worktreeDir = path.join(await realTmpDir(), `pi-wt-list-${Date.now()}`);
		try {
			execSync("git branch worker/list-test", { cwd: dir, stdio: "pipe" });

			const handle = await createWorktree({
				repoDir: dir,
				branch: "worker/list-test",
				worktreeDir,
			});

			try {
				const worktrees = await listWorktrees(dir);
				assert(
					worktrees.some((p) => p === worktreeDir),
					`Expected ${worktreeDir} in worktrees, got: ${JSON.stringify(worktrees)}`,
				);
			} finally {
				await handle.cleanup();
			}
		} finally {
			await cleanupRepo(dir);
			await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	// ── TEST 6: cleanup() — removes worktree ─────────────────────────────────
	await runner.test("cleanup() removes the worktree from listWorktrees", async () => {
		const { dir } = await makeTempGitRepo();
		const worktreeDir = path.join(await realTmpDir(), `pi-wt-clean-${Date.now()}`);
		try {
			execSync("git branch worker/cleanup-test", { cwd: dir, stdio: "pipe" });

			const handle = await createWorktree({
				repoDir: dir,
				branch: "worker/cleanup-test",
				worktreeDir,
			});

			// Confirm it appears before cleanup
			const before = await listWorktrees(dir);
			assert(
				before.some((p) => p === worktreeDir),
				"Worktree should appear in listWorktrees before cleanup",
			);

			await handle.cleanup();

			const after = await listWorktrees(dir);
			assert(
				!after.some((p) => p === worktreeDir),
				`Worktree should be removed after cleanup, got: ${JSON.stringify(after)}`,
			);
		} finally {
			await cleanupRepo(dir);
			await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	const { failed } = runner.summary();
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error("Test runner failed:", err);
	process.exit(1);
});

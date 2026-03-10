#!/usr/bin/env npx jiti
/**
 * Unit tests for coordinate/worktree-manager.ts
 *
 * Tests use the project's standard TestRunner and run via:
 *   npx jiti tests/unit/worktree-manager.test.ts
 *
 * Six tests:
 *   1. shouldUseWorktrees returns false for single worker
 *   2. shouldUseWorktrees returns false for non-git directory
 *   3. shouldUseWorktrees returns true for valid non-bare git repo
 *   4. allocateWorktree generates correct path and branch name
 *   5. mergeWorktreeBranch success path returns { success: true }
 *   6. mergeWorktreeBranch conflict path returns { success: false, conflicts }
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

import { TestRunner, assert, assertEqual } from "../test-utils.js";

async function makeTempGitRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wt-test-"));
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	await fs.writeFile(path.join(dir, "README.md"), "test repo");
	execSync("git add .", { cwd: dir, stdio: "pipe" });
	execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

async function cleanup(dir: string): Promise<void> {
	try {
		try { execSync("git worktree prune", { cwd: dir, stdio: "pipe" }); } catch {}
		await fs.rm(dir, { recursive: true, force: true });
	} catch {}
}

async function main() {
	const runner = new TestRunner();

	const {
		shouldUseWorktrees,
		allocateWorktree,
		releaseWorktree,
		mergeWorktreeBranch,
	} = await import("../../coordinate/worktree-manager.ts");

	runner.section("shouldUseWorktrees");

	await runner.test("returns false when workerCount is 1 (no git check needed)", async () => {
		const result = await shouldUseWorktrees(os.tmpdir(), 1);
		assertEqual(result, false, "Expected false for single worker, got true");
	});

	await runner.test("returns false for a non-git directory", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-no-git-"));
		try {
			const result = await shouldUseWorktrees(tmpDir, 3);
			assertEqual(result, false, "Expected false for non-git dir, got true");
		} finally {
			await cleanup(tmpDir);
		}
	});

	await runner.test("returns true for a valid non-bare git repo with 2+ workers", async () => {
		const repoDir = await makeTempGitRepo();
		try {
			const result = await shouldUseWorktrees(repoDir, 3);
			assertEqual(result, true, "Expected true for valid git repo, got false");
		} finally {
			await cleanup(repoDir);
		}
	});

	runner.section("allocateWorktree");

	await runner.test("creates a worktree with correct path and branch name", async () => {
		const repoDir = await makeTempGitRepo();
		let allocation: Awaited<ReturnType<typeof allocateWorktree>> | undefined;
		try {
			allocation = await allocateWorktree(repoDir, "sess-abc123", "TASK-01");
			assert(allocation.worktreePath.startsWith(os.tmpdir()), `Expected under tmpdir, got: ${allocation.worktreePath}`);
			assert(allocation.worktreePath.includes("pi-coord-"), `Expected 'pi-coord-' in path, got: ${allocation.worktreePath}`);
			assert(allocation.branchName.startsWith("agent/"), `Expected 'agent/' branch prefix, got: ${allocation.branchName}`);
			assert(allocation.branchName.includes("TASK-01"), `Expected 'TASK-01' in branch, got: ${allocation.branchName}`);
			assertEqual(allocation.taskId, "TASK-01");
			assert(Boolean(new Date(allocation.createdAt).getTime()), "createdAt should be a valid date");
			assert(fsSync.existsSync(allocation.worktreePath), `Worktree dir should exist at: ${allocation.worktreePath}`);
		} finally {
			if (allocation) { try { await releaseWorktree(allocation, repoDir); } catch {} }
			await cleanup(repoDir);
		}
	});

	runner.section("mergeWorktreeBranch");

	await runner.test("returns { success: true } when there are no conflicts", async () => {
		const repoDir = await makeTempGitRepo();
		let allocation: Awaited<ReturnType<typeof allocateWorktree>> | undefined;
		try {
			allocation = await allocateWorktree(repoDir, "sess-merge", "TASK-02");
			await fs.writeFile(path.join(allocation.worktreePath, "feature.txt"), "feature work");
			execSync("git add .", { cwd: allocation.worktreePath, stdio: "pipe" });
			execSync('git commit -m "feat: add feature.txt"', { cwd: allocation.worktreePath, stdio: "pipe" });
			execSync(`git checkout "${allocation.baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
			const result = await mergeWorktreeBranch(allocation, repoDir, allocation.baseBranch);
			assertEqual(result.success, true, `Expected merge success, got: ${JSON.stringify(result)}`);
			assert(!result.conflicts, "Expected no conflicts on clean merge");
		} finally {
			if (allocation) { try { await releaseWorktree(allocation, repoDir); } catch {} }
			await cleanup(repoDir);
		}
	});

	await runner.test("returns { success: false, conflicts } when merge has conflicts", async () => {
		const repoDir = await makeTempGitRepo();
		let allocation: Awaited<ReturnType<typeof allocateWorktree>> | undefined;
		try {
			allocation = await allocateWorktree(repoDir, "sess-conflict", "TASK-03");
			await fs.writeFile(path.join(allocation.worktreePath, "conflict.txt"), "worktree version\n");
			execSync("git add .", { cwd: allocation.worktreePath, stdio: "pipe" });
			execSync('git commit -m "worktree: add conflict.txt"', { cwd: allocation.worktreePath, stdio: "pipe" });
			execSync(`git checkout "${allocation.baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
			await fs.writeFile(path.join(repoDir, "conflict.txt"), "main branch version\n");
			execSync("git add .", { cwd: repoDir, stdio: "pipe" });
			execSync('git commit -m "main: add conflict.txt"', { cwd: repoDir, stdio: "pipe" });
			const result = await mergeWorktreeBranch(allocation, repoDir, allocation.baseBranch);
			assertEqual(result.success, false, `Expected merge conflict, got success`);
			assert(Array.isArray(result.conflicts) && result.conflicts.length > 0, `Expected non-empty conflicts, got: ${JSON.stringify(result.conflicts)}`);
			assert(result.conflicts!.some(f => f.includes("conflict")), `Expected 'conflict.txt' in conflicts, got: ${JSON.stringify(result.conflicts)}`);
		} finally {
			if (allocation) { try { await releaseWorktree(allocation, repoDir); } catch {} }
			await cleanup(repoDir);
		}
	});

	const { failed } = runner.summary();
	if (failed > 0) process.exit(1);
}

main().catch(err => {
	console.error("Test runner failed:", err);
	process.exit(1);
});

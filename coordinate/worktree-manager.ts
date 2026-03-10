/**
 * Git Worktree Manager for pi-coordination
 *
 * Allocates isolated git worktrees for parallel workers so they don't
 * fight over the same working directory. Each worker gets its own branch
 * and directory, then merges back after completion.
 *
 * This is the 2026 standard used by Claude Code Agent Teams, Cursor parallel
 * agents, and VS Code Background Agents.
 */

import { execSync, exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface WorktreeAllocation {
	/** Absolute path to the isolated worktree directory, e.g. /tmp/pi-coord-{sessionId}-worker-{n} */
	worktreePath: string;
	/** Branch name for this worktree, e.g. agent/{sessionId}/{taskId} */
	branchName: string;
	/** The task ID this worktree is assigned to */
	taskId: string;
	/** ISO timestamp when this allocation was created */
	createdAt: string;
	/** The base branch that was checked out when this worktree was created */
	baseBranch: string;
}

/**
 * Derive a safe path component from a string by replacing non-alphanumeric chars.
 */
function safeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
}

/**
 * Get current branch name in a repo.
 */
function getCurrentBranch(repoRoot: string): string {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repoRoot,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();
	} catch {
		return "main";
	}
}

/**
 * Allocate a new git worktree for a worker task.
 *
 * Creates a new branch `agent/{sessionId}/{taskId}` and a worktree at
 * `/tmp/pi-coord-{sessionId}-{taskId}` pointing to that branch.
 *
 * @param repoRoot  Absolute path to the git repository root
 * @param sessionId Coordination session ID (used to namespace branches/paths)
 * @param taskId    Task ID (e.g. "TASK-01")
 * @returns WorktreeAllocation describing the created worktree
 */
export async function allocateWorktree(
	repoRoot: string,
	sessionId: string,
	taskId: string,
): Promise<WorktreeAllocation> {
	const safeSession = safeName(sessionId).slice(0, 20);
	const safeTask = safeName(taskId).slice(0, 20);

	const worktreePath = path.join(
		os.tmpdir(),
		`pi-coord-${safeSession}-${safeTask}`,
	);
	const branchName = `agent/${safeSession}/${safeTask}`;
	const baseBranch = getCurrentBranch(repoRoot);

	// Clean up any stale worktree at this path
	if (fsSync.existsSync(worktreePath)) {
		try {
			await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: repoRoot });
		} catch {
			await fs.rm(worktreePath, { recursive: true, force: true });
		}
	}

	// Delete the branch if it already exists (stale from a previous run)
	try {
		execSync(`git branch -D "${branchName}"`, { cwd: repoRoot, stdio: "pipe" });
	} catch {
		// Branch didn't exist — that's fine
	}

	// Create the worktree with a new branch
	await execAsync(
		`git worktree add "${worktreePath}" -b "${branchName}"`,
		{ cwd: repoRoot },
	);

	return {
		worktreePath,
		branchName,
		taskId,
		createdAt: new Date().toISOString(),
		baseBranch,
	};
}

/**
 * Release (remove) a git worktree and its associated branch.
 *
 * @param allocation  The WorktreeAllocation returned by allocateWorktree
 * @param repoRoot    Absolute path to the git repository root
 */
export async function releaseWorktree(
	allocation: WorktreeAllocation,
	repoRoot: string,
): Promise<void> {
	try {
		await execAsync(
			`git worktree remove "${allocation.worktreePath}" --force`,
			{ cwd: repoRoot },
		);
	} catch {
		try {
			await fs.rm(allocation.worktreePath, { recursive: true, force: true });
		} catch {
			console.warn(`[worktree] Failed to remove directory: ${allocation.worktreePath}`);
		}
	}

	try {
		execSync(`git branch -d "${allocation.branchName}"`, {
			cwd: repoRoot,
			stdio: "pipe",
		});
	} catch {
		try {
			execSync(`git branch -D "${allocation.branchName}"`, {
				cwd: repoRoot,
				stdio: "pipe",
			});
		} catch {
			console.warn(`[worktree] Failed to delete branch: ${allocation.branchName}`);
		}
	}

	try {
		execSync("git worktree prune", { cwd: repoRoot, stdio: "pipe" });
	} catch {
		// Non-fatal
	}
}

/**
 * Merge a worktree branch back into the current working branch.
 *
 * @param allocation    The WorktreeAllocation to merge
 * @param repoRoot      Absolute path to the git repository root
 * @param targetBranch  Branch to merge INTO (defaults to baseBranch from allocation)
 * @returns             { success: true } or { success: false, conflicts: string[] }
 */
export async function mergeWorktreeBranch(
	allocation: WorktreeAllocation,
	repoRoot: string,
	targetBranch?: string,
): Promise<{ success: boolean; conflicts?: string[] }> {
	const target = targetBranch ?? allocation.baseBranch;

	try {
		execSync(`git checkout "${target}"`, { cwd: repoRoot, stdio: "pipe" });
	} catch {
		return {
			success: false,
			conflicts: [`Could not checkout target branch: ${target}`],
		};
	}

	try {
		await execAsync(
			`git merge "${allocation.branchName}" --no-ff -m "Merge ${allocation.taskId} (worktree branch ${allocation.branchName})"`,
			{ cwd: repoRoot },
		);
		return { success: true };
	} catch (err) {
		let conflicts: string[] = [];
		try {
			const { stdout } = await execAsync(
				"git diff --name-only --diff-filter=U",
				{ cwd: repoRoot },
			);
			conflicts = stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
		} catch {
			const msg = String(err);
			const conflictMatches = msg.match(/CONFLICT[^:]*: (.+)/g) || [];
			conflicts = conflictMatches.map((m) => m.replace(/CONFLICT[^:]*: /, "").trim());
		}

		try {
			execSync("git merge --abort", { cwd: repoRoot, stdio: "pipe" });
		} catch {
			// merge --abort fails if there's nothing to abort
		}

		return { success: false, conflicts };
	}
}

/**
 * Clean up ALL worktrees for a given session.
 *
 * @param repoRoot   Absolute path to the git repository root
 * @param sessionId  Session ID to clean up
 */
export async function cleanupAllWorktrees(
	repoRoot: string,
	sessionId: string,
): Promise<void> {
	const safeSession = safeName(sessionId).slice(0, 20);
	const prefix = `pi-coord-${safeSession}-`;

	let worktreeList: string;
	try {
		const { stdout } = await execAsync("git worktree list --porcelain", { cwd: repoRoot });
		worktreeList = stdout;
	} catch {
		return;
	}

	const paths = worktreeList
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.replace("worktree ", "").trim())
		.filter((p) => path.basename(p).startsWith(prefix));

	await Promise.allSettled(
		paths.map(async (worktreePath) => {
			const suffix = path.basename(worktreePath).replace(`pi-coord-${safeSession}-`, "");
			const branchName = `agent/${safeSession}/${suffix}`;
			const allocation: WorktreeAllocation = {
				worktreePath,
				branchName,
				taskId: suffix,
				createdAt: "",
				baseBranch: "",
			};
			await releaseWorktree(allocation, repoRoot);
		}),
	);
}

/**
 * Auto-detect whether worktree isolation should be used for this coordination session.
 *
 * Returns true when:
 * - More than 1 worker is running in parallel
 * - The target directory is a non-bare git repo
 *
 * @param repoRoot     Directory to check
 * @param workerCount  Number of parallel workers about to be spawned
 */
export async function shouldUseWorktrees(
	repoRoot: string,
	workerCount: number,
): Promise<boolean> {
	if (workerCount <= 1) return false;

	try {
		execSync("git rev-parse --git-dir", { cwd: repoRoot, stdio: "pipe" });

		const isBare = execSync("git rev-parse --is-bare-repository", {
			cwd: repoRoot,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();

		if (isBare === "true") return false;

		return true;
	} catch {
		return false;
	}
}

/**
 * Register process exit handlers to clean up all worktrees for a session.
 *
 * @param repoRoot   Absolute path to the git repository root
 * @param sessionId  Session ID to clean up on exit
 */
export function registerWorktreeCleanupHandlers(
	repoRoot: string,
	sessionId: string,
): void {
	const cleanup = () => {
		const safeSession = safeName(sessionId).slice(0, 20);
		const prefix = `pi-coord-${safeSession}-`;

		try {
			const worktreeList = execSync("git worktree list --porcelain", {
				cwd: repoRoot,
				stdio: "pipe",
				encoding: "utf-8",
			});

			const paths = worktreeList
				.split("\n")
				.filter((line) => line.startsWith("worktree "))
				.map((line) => line.replace("worktree ", "").trim())
				.filter((p) => path.basename(p).startsWith(prefix));

			for (const wPath of paths) {
				try {
					execSync(`git worktree remove "${wPath}" --force`, {
						cwd: repoRoot,
						stdio: "pipe",
					});
				} catch {
					// Best-effort
				}
			}

			execSync("git worktree prune", { cwd: repoRoot, stdio: "pipe" });
		} catch {
			// Non-fatal during shutdown
		}
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	process.on("exit", cleanup);
}

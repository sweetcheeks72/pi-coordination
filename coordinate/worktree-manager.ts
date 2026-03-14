/**
 * worktree-manager.ts — Git worktree lifecycle management.
 *
 * H-4 fix: SIGINT/SIGTERM cleanup uses execFile (async, non-blocking) with a
 * 5-second timeout instead of execSync (blocking, no timeout).  Blocking the
 * signal handler with execSync can deadlock the process on a busy filesystem.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface WorktreeOptions {
	/** Root git repository directory */
	repoDir: string;
	/** Branch name to check out in the worktree */
	branch: string;
	/** Directory to create the worktree in (defaults to <repoDir>/../<branch>) */
	worktreeDir?: string;
}

export interface WorktreeHandle {
	/** Absolute path to the worktree directory */
	worktreePath: string;
	/** Branch that is checked out */
	branch: string;
	/** Remove the worktree and deregister signal handlers */
	cleanup: () => Promise<void>;
}

const CLEANUP_TIMEOUT_MS = 5000;

/** Run a git command asynchronously with a timeout. */
function gitAsync(args: string[], cwd: string, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: timeoutMs }, (err) => {
			if (err) {
				console.debug("[worktree-manager] git", args.join(" "), "→", err.message);
			}
			resolve();
		});
	});
}

/**
 * Create a git worktree for `branch` inside `worktreeDir`.
 * Registers SIGINT/SIGTERM handlers that asynchronously remove the worktree
 * with a 5-second timeout so cleanup never blocks the event loop.
 */
export async function createWorktree(opts: WorktreeOptions): Promise<WorktreeHandle> {
	const { repoDir, branch } = opts;
	const worktreePath =
		opts.worktreeDir ?? path.join(path.dirname(repoDir), branch.replace(/[/\\]/g, "-"));

	await fs.mkdir(path.dirname(worktreePath), { recursive: true });

	await gitAsync(["worktree", "add", worktreePath, branch], repoDir);

	let cleanedUp = false;

	const cleanup = async (): Promise<void> => {
		if (cleanedUp) return;
		cleanedUp = true;
		await gitAsync(["worktree", "remove", "--force", worktreePath], repoDir);
	};

	// H-4: use execFile (async, 5s timeout) instead of execSync in signal handlers.
	const onSignal = (): void => {
		// Fire-and-forget async cleanup — do NOT block the signal handler.
		execFile(
			"git",
			["worktree", "remove", "--force", worktreePath],
			{ cwd: repoDir, timeout: CLEANUP_TIMEOUT_MS },
			() => process.exit(0),
		);
	};

	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	return {
		worktreePath,
		branch,
		cleanup: async () => {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			await cleanup();
		},
	};
}

/**
 * List all registered worktrees for the repository at `repoDir`.
 */
export function listWorktrees(repoDir: string): Promise<string[]> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["worktree", "list", "--porcelain"],
			{ cwd: repoDir, timeout: CLEANUP_TIMEOUT_MS },
			(err, stdout) => {
				if (err) {
					resolve([]);
					return;
				}
				const paths = stdout
					.split("\n")
					.filter((l) => l.startsWith("worktree "))
					.map((l) => l.slice("worktree ".length).trim());
				resolve(paths);
			},
		);
	});
}

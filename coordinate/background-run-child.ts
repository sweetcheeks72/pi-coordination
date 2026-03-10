#!/usr/bin/env node
/**
 * background-run-child.ts
 *
 * Entry point for a detached background coordination run.
 * Invoked by startBackgroundRun() via `node jiti-cli.mjs background-run-child.ts <cfg.json>`.
 *
 * Reads a config JSON written by the parent, runs the full coordination
 * session, and updates status.json + sends a macOS notification on completion.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { markRunComplete, markRunFailed } from "./background-runner.js";

interface ChildConfig {
	runId: string;
	specPath: string;
	options: Record<string, unknown>;
	cwd: string;
	statusPath: string;
	logPath: string;
}

async function main(): Promise<void> {
	const cfgPath = process.argv[2];
	if (!cfgPath) {
		console.error("[background-run-child] No config path provided");
		process.exit(1);
	}

	let cfg: ChildConfig;
	try {
		cfg = JSON.parse(await fs.readFile(cfgPath, "utf-8"));
	} catch (err) {
		console.error(`[background-run-child] Failed to read config: ${err}`);
		process.exit(1);
	}

	// Clean up the temporary config file
	try {
		await fs.unlink(cfgPath);
	} catch {
		// Best-effort
	}

	console.log(`[background-run-child] Starting run ${cfg.runId} for spec: ${cfg.specPath}`);
	console.log(`[background-run-child] Log: ${cfg.logPath}`);

	try {
		// Dynamic import to avoid circular deps and allow jiti to resolve TS
		const { runCoordinationSession } = await import("./index.js");
		const { EventEmitter } = await import("node:events");

		const events = new EventEmitter() as any;
		events.emit = (event: string, ...args: unknown[]) => {
			EventEmitter.prototype.emit.call(events, event, ...args);
			return true;
		};

		const sessionDir =
			process.env.PI_SESSION_DIR ||
			path.join(os.homedir(), ".pi", "sessions", "default");

		const { result } = await runCoordinationSession({
			runtime: { cwd: cfg.cwd, events },
			params: {
				plan: cfg.specPath,
				...cfg.options,
			} as any,
			sessionDir,
		});

		// Extract cost from result details if available
		const cost = (result.details as any)?.cost?.total;

		if (result.isError) {
			const errText = result.content.find((c: any) => c.type === "text")?.text || "unknown error";
			console.error(`[background-run-child] Coordination failed: ${errText}`);
			await markRunFailed(cfg.runId, errText);
		} else {
			console.log(`[background-run-child] Coordination complete for run ${cfg.runId}`);
			await markRunComplete(cfg.runId, cost);
		}
	} catch (err) {
		console.error(`[background-run-child] Fatal error: ${err}`);
		await markRunFailed(cfg.runId, String(err)).catch(() => {});
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[background-run-child] Uncaught error: ${err}`);
	process.exit(1);
});

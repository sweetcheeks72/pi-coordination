import * as fs from "node:fs";
import * as path from "node:path";
import { createEventBus } from "@mariozechner/pi-coding-agent";
import { runCoordinationSession } from "./index.js";

interface AsyncCoordinationConfig {
	asyncId: string;
	coordSessionId?: string;
	coordDir?: string;
	planPath: string;
	params: Record<string, unknown>;
	cwd: string;
	resultPath: string;
	sessionDir?: string;
	traceId?: string;
	parentPid?: number;
}

function buildRuntime(cwd: string) {
	return {
		cwd,
		events: createEventBus(),
	};
}

function extractSummary(result: { content?: Array<{ type: string; text?: string }> }): string {
	const text = result.content?.find((c) => c.type === "text")?.text;
	return text || "";
}

function writeJson(pathname: string, payload: unknown): void {
	const dir = path.dirname(pathname);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {}
	const tmpPath = `${pathname}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
	fs.renameSync(tmpPath, pathname);
}

function writeResult(resultPath: string, payload: unknown): void {
	writeJson(resultPath, payload);
}

function writeAsyncStatus(
	coordDir: string | undefined,
	payload: Record<string, unknown>,
): string | undefined {
	if (!coordDir) return undefined;
	const statusPath = path.join(coordDir, "async", "status.json");
	writeJson(statusPath, payload);
	return statusPath;
}

async function main(): Promise<void> {
	const configPath = process.argv[2];
	if (!configPath) {
		throw new Error("Missing config path argument");
	}

	const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AsyncCoordinationConfig;
	const startTime = Date.now();
	const runtime = buildRuntime(config.cwd);
	const params = { ...config.params };

	if (params.logPath === undefined && config.coordDir) {
		params.logPath = config.coordDir;
	}

	let payload: Record<string, unknown>;
	const statusPayloadBase = {
		asyncId: config.asyncId,
		coordDir: config.coordDir,
		planPath: config.planPath,
		cwd: config.cwd,
		parentPid: config.parentPid,
		startedAt: startTime,
	};

	const statusPath = writeAsyncStatus(config.coordDir, {
		...statusPayloadBase,
		status: "running",
	});

	try {
		const { result, coordDir, traceId } = await runCoordinationSession({
			runtime,
			params: params as any,
			coordSessionId: config.coordSessionId ?? config.asyncId,
			coordDir: config.coordDir,
			sessionDir: config.sessionDir,
			traceId: config.traceId,
			toolCtx: {
				hasPendingMessages: () => false,
				abort: () => {},
			},
		});

		payload = {
			asyncId: config.asyncId,
			status: result.isError ? "failed" : "complete",
			summary: extractSummary(result),
			coordDir,
			traceId,
			cwd: config.cwd,
			parentPid: config.parentPid,
			startedAt: startTime,
			completedAt: Date.now(),
			durationMs: Date.now() - startTime,
			cost: result.details?.cost?.total ?? 0,
			isError: result.isError ?? false,
			statusPath,
		};

		writeAsyncStatus(coordDir, {
			...statusPayloadBase,
			status: result.isError ? "failed" : "complete",
			traceId,
			completedAt: payload.completedAt,
			durationMs: payload.durationMs,
			cost: payload.cost,
			summary: payload.summary,
		});
	} catch (err) {
		payload = {
			asyncId: config.asyncId,
			status: "failed",
			summary: `Coordination failed: ${err}`,
			coordDir: config.coordDir,
			traceId: config.traceId,
			cwd: config.cwd,
			parentPid: config.parentPid,
			startedAt: startTime,
			completedAt: Date.now(),
			durationMs: Date.now() - startTime,
			isError: true,
			error: String(err),
			statusPath,
		};

		writeAsyncStatus(config.coordDir, {
			...statusPayloadBase,
			status: "failed",
			completedAt: payload.completedAt,
			durationMs: payload.durationMs,
			error: payload.error,
			summary: payload.summary,
		});
	}

	writeResult(config.resultPath, payload);
	try {
		fs.unlinkSync(configPath);
	} catch {}
}

main().catch((err) => {
	process.stderr.write(`async-runner error: ${err}\n`);
	process.exit(1);
});

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
	ObservableEvent,
	Span,
	CausalLink,
	StructuredError,
	ResourceEvent,
	Decision,
} from "../observability/types.js";
import type { WorkerStateFile, Contract, PipelineState, CoordinationEvent } from "../types.js";
import type { ObservabilityData, FileOutput } from "./types.js";

type AnyEvent = ObservableEvent | CoordinationEvent;

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function loadJsonl<T>(filePath: string): Promise<T[]> {
	if (!(await fileExists(filePath))) return [];

	const content = await fs.readFile(filePath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);
	const results: T[] = [];

	for (const line of lines) {
		try {
			results.push(JSON.parse(line) as T);
		} catch {
			continue;
		}
	}

	return results;
}

async function loadJson<T>(filePath: string): Promise<T | null> {
	if (!(await fileExists(filePath))) return null;

	try {
		const content = await fs.readFile(filePath, "utf-8");
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

async function loadWorkerStates(coordDir: string): Promise<WorkerStateFile[]> {
	const workersDir = path.join(coordDir, "workers");
	if (!(await fileExists(workersDir))) return [];

	const entries = await fs.readdir(workersDir, { withFileTypes: true });
	const states: WorkerStateFile[] = [];

	for (const entry of entries) {
		if (entry.isDirectory()) {
			const statePath = path.join(workersDir, entry.name, "state.json");
			const state = await loadJson<WorkerStateFile>(statePath);
			if (state) states.push(state);
		}
	}

	return states;
}

async function loadContracts(coordDir: string): Promise<Record<string, Contract>> {
	const contractsPath = path.join(coordDir, "contracts.json");
	const contracts = await loadJson<Record<string, Contract>>(contractsPath);
	return contracts || {};
}

async function loadPipelineState(coordDir: string): Promise<PipelineState | undefined> {
	const statePath = path.join(coordDir, "pipeline-state.json");
	const state = await loadJson<PipelineState>(statePath);
	return state || undefined;
}

async function getFileHash(filePath: string): Promise<string> {
	const content = await fs.readFile(filePath);
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function loadFileOutputs(
	coordDir: string,
	events: ObservableEvent[],
	workerStates: WorkerStateFile[],
): Promise<FileOutput[]> {
	const filesModified = new Set<string>();

	for (const state of workerStates) {
		for (const file of state.filesModified) {
			filesModified.add(file);
		}
	}

	for (const event of events) {
		if (event.type === "worker_completed" && event.result?.filesModified) {
			for (const file of event.result.filesModified) {
				filesModified.add(file);
			}
		}
	}

	const outputs: FileOutput[] = [];
	const cwd = process.cwd();

	for (const file of filesModified) {
		const fullPath = path.isAbsolute(file) ? file : path.join(cwd, file);
		const exists = await fileExists(fullPath);

		let size: number | undefined;
		let hash: string | undefined;

		if (exists) {
			const stat = await fs.stat(fullPath);
			size = stat.size;
			hash = await getFileHash(fullPath);
		}

		outputs.push({
			path: file,
			exists,
			isNew: exists,
			size,
			hash,
		});
	}

	return outputs;
}

function isObservableEvent(event: AnyEvent): event is ObservableEvent {
	return "id" in event && "traceId" in event && "actor" in event;
}

function normalizeEvents(rawEvents: AnyEvent[]): ObservableEvent[] {
	return rawEvents.filter(isObservableEvent);
}

export async function loadObservabilityData(coordDir: string): Promise<ObservabilityData> {
	const [rawEvents, spans, causalLinks, errors, resources, decisions, workerStates, contracts, pipelineState] =
		await Promise.all([
			loadJsonl<AnyEvent>(path.join(coordDir, "events.jsonl")),
			loadJsonl<Span>(path.join(coordDir, "traces", "spans.jsonl")),
			loadJsonl<CausalLink>(path.join(coordDir, "causality.jsonl")),
			loadJsonl<StructuredError>(path.join(coordDir, "errors.jsonl")),
			loadJsonl<ResourceEvent>(path.join(coordDir, "resources.jsonl")),
			loadJsonl<Decision>(path.join(coordDir, "decisions.jsonl")),
			loadWorkerStates(coordDir),
			loadContracts(coordDir),
			loadPipelineState(coordDir),
		]);

	const events = normalizeEvents(rawEvents);
	const fileOutputs = await loadFileOutputs(coordDir, events, workerStates);

	return {
		events,
		spans,
		causalLinks,
		errors,
		resources,
		decisions,
		workerStates,
		contracts,
		pipelineState,
		fileOutputs,
	};
}

export function isSessionComplete(data: ObservabilityData): boolean {
	return data.events.some((e) => e.type === "session_completed");
}

export function getLastEvent(data: ObservabilityData): ObservableEvent | undefined {
	return data.events[data.events.length - 1];
}

export function getEventsByType<T extends ObservableEvent["type"]>(
	events: ObservableEvent[],
	type: T,
): Extract<ObservableEvent, { type: T }>[] {
	return events.filter((e) => e.type === type) as Extract<ObservableEvent, { type: T }>[];
}

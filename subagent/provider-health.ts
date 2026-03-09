import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ProviderFailureCategory = "success" | "rate_limit" | "mcp_connection" | "unknown";

export interface ProviderAttemptRecord {
	timestamp: number;
	provider: string;
	model?: string;
	agent?: string;
	status: ProviderFailureCategory;
	exitCode?: number;
	errorMessage?: string;
	stopReason?: string;
}

export interface ProviderCandidateStatus {
	model: string;
	provider: string | null;
	retryAt?: number;
	cooldownActive: boolean;
}

export interface ProviderSelectionMeta {
	parentModel?: string;
	parentProvider?: string | null;
	selectedModel?: string;
	selectedProvider?: string | null;
	consideredModels: string[];
	blockedModels: Array<{ model: string; provider: string | null; retryAt: number }>;
	divergenceReason?: string;
}

export const DEFAULT_PROVIDER_HISTORY_PATH = path.join(os.homedir(), ".pi", "agent", "provider-health-history.jsonl");

export function inferProviderFromModel(modelId: string | undefined): string | null {
	if (!modelId) return null;
	const id = modelId.toLowerCase();
	if (id.startsWith("anthropic/")) return "anthropic";
	if (id.startsWith("openai/") || id.startsWith("openai-codex/")) return "openai";
	if (id.startsWith("google/")) return "google";
	if (id.startsWith("deepseek/")) return "deepseek";
	const bare = id.includes("/") ? id.split("/", 2)[1] : id;
	if (bare.startsWith("claude")) return "anthropic";
	if (bare.startsWith("gpt") || bare.startsWith("o1") || bare.startsWith("o3") || bare.startsWith("o4")) return "openai";
	if (bare.startsWith("gemini")) return "google";
	if (bare.startsWith("deepseek")) return "deepseek";
	return null;
}

export function parseModelCandidates(modelSpec: string | undefined): string[] {
	if (!modelSpec) return [];
	return modelSpec.split(",").map((item) => item.trim()).filter(Boolean);
}

export function loadProviderHistory(filePath: string = DEFAULT_PROVIDER_HISTORY_PATH): ProviderAttemptRecord[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		return fs.readFileSync(filePath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ProviderAttemptRecord)
			.filter((item) => !!item && typeof item.timestamp === "number");
	} catch {
		return [];
	}
}

export function classifyProviderFailure(text: string): ProviderFailureCategory {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) return "unknown";
	if (normalized.includes("rate_limit_error") || (normalized.includes("429") && normalized.includes("rate limit"))) return "rate_limit";
	if (normalized.includes("failed to connect to memgraph") || normalized.includes("mcp error -32000") || normalized.includes("connection closed")) return "mcp_connection";
	return "unknown";
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function estimateProviderCooldownMs(provider: string, history: ProviderAttemptRecord[], now: number = Date.now()): number | undefined {
	const providerHistory = history.filter((item) => item.provider === provider).sort((a, b) => a.timestamp - b.timestamp);
	if (providerHistory.length === 0) return undefined;
	const rateLimits = providerHistory.filter((item) => item.status === "rate_limit");
	if (rateLimits.length === 0) return undefined;

	const recoveries: number[] = [];
	for (const rl of rateLimits) {
		const success = providerHistory.find((item) => item.status === "success" && item.timestamp > rl.timestamp);
		if (success) recoveries.push(success.timestamp - rl.timestamp);
	}
	const learned = median(recoveries.filter((value) => value > 0));
	if (learned !== undefined) return learned;

	const recentWindowStart = now - 30 * 60 * 1000;
	const recentCount = rateLimits.filter((item) => item.timestamp >= recentWindowStart).length;
	if (recentCount >= 3) return 30 * 60 * 1000;
	if (recentCount >= 2) return 15 * 60 * 1000;
	return 5 * 60 * 1000;
}

export function estimateRetryAt(provider: string, history: ProviderAttemptRecord[], now: number = Date.now()): number | undefined {
	const lastRateLimit = [...history].reverse().find((item) => item.provider === provider && item.status === "rate_limit");
	if (!lastRateLimit) return undefined;
	const cooldownMs = estimateProviderCooldownMs(provider, history, now);
	if (!cooldownMs) return undefined;
	return lastRateLimit.timestamp + cooldownMs;
}


export function resolveParentModelHint(explicitParentModel: string | undefined, envModel: string | undefined): string | undefined {
	return explicitParentModel || envModel || undefined;
}

export function buildParentModelEnv(baseEnv: NodeJS.ProcessEnv, parentModel: string | undefined): NodeJS.ProcessEnv {
	return parentModel ? { ...baseEnv, PI_MODEL: parentModel } : { ...baseEnv };
}

export function selectModelCandidate(modelSpec: string | undefined, parentModel: string | undefined, now: number = Date.now(), historyPath: string = DEFAULT_PROVIDER_HISTORY_PATH): ProviderSelectionMeta {
	const history = loadProviderHistory(historyPath);
	const configuredCandidates = parseModelCandidates(modelSpec);
	const candidates = configuredCandidates.length > 0 ? configuredCandidates : (parentModel ? [parentModel] : []);
	const parentProvider = inferProviderFromModel(parentModel);

	const statuses: ProviderCandidateStatus[] = candidates.map((model) => {
		const provider = inferProviderFromModel(model);
		const retryAt = provider ? estimateRetryAt(provider, history, now) : undefined;
		return { model, provider, retryAt, cooldownActive: retryAt !== undefined && retryAt > now };
	});

	statuses.sort((a, b) => {
		if (a.cooldownActive !== b.cooldownActive) return a.cooldownActive ? 1 : -1;
		const aParent = parentProvider && a.provider === parentProvider ? 1 : 0;
		const bParent = parentProvider && b.provider === parentProvider ? 1 : 0;
		if (aParent !== bParent) return bParent - aParent;
		const aRetry = a.retryAt ?? 0;
		const bRetry = b.retryAt ?? 0;
		if (a.cooldownActive && b.cooldownActive && aRetry !== bRetry) return aRetry - bRetry;
		return candidates.indexOf(a.model) - candidates.indexOf(b.model);
	});

	const selected = statuses[0];
	let divergenceReason: string | undefined;
	if (parentModel && selected?.model && selected.model !== parentModel) {
		divergenceReason = selected.provider === parentProvider ? "selected sibling model on parent provider" : "selected healthiest provider candidate";
	}

	return {
		parentModel,
		parentProvider,
		selectedModel: selected?.model,
		selectedProvider: selected?.provider ?? null,
		consideredModels: candidates,
		blockedModels: statuses
			.filter((item) => item.cooldownActive && item.retryAt !== undefined)
			.map((item) => ({ model: item.model, provider: item.provider, retryAt: item.retryAt! })),
		divergenceReason,
	};
}

export function recordProviderOutcome(record: Omit<ProviderAttemptRecord, "timestamp"> & { timestamp?: number }, filePath: string = DEFAULT_PROVIDER_HISTORY_PATH): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const entry: ProviderAttemptRecord = { ...record, timestamp: record.timestamp ?? Date.now() };
		fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", { encoding: "utf-8", mode: 0o600 });
	} catch {
		// non-fatal telemetry
	}
}

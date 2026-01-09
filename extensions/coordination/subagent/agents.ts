/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	systemPromptMode?: "append" | "override"; // "append" (default) adds to pi's prompt, "override" replaces it
	source: "user" | "project";
	filePath: string;
	/** Extension paths (relative to agent file or absolute). When set, skips global extension discovery. */
	extensions?: string | string[];
	/** Skills to load. Empty array [] = skip skill discovery. Undefined = discover. */
	skills?: string[];
	/** Context files to load. Empty array [] = skip discovery. Undefined = discover. */
	contextFiles?: string[];
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface ParsedFrontmatter {
	/** Simple key-value pairs (for backwards compatibility) */
	values: Record<string, string>;
	/** Array values (for extensions, skills, context-files) */
	arrays: Record<string, string[]>;
}

function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter; body: string } {
	const frontmatter: ParsedFrontmatter = { values: {}, arrays: {} };
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	const lines = frontmatterBlock.split("\n");
	let currentArrayKey: string | null = null;
	let currentArrayValues: string[] = [];

	for (const line of lines) {
		// Check for array continuation (lines starting with "  - ")
		if (currentArrayKey && line.match(/^\s+-\s+/)) {
			const value = line.replace(/^\s+-\s+/, "").trim();
			// Remove quotes if present
			const unquoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
				? value.slice(1, -1)
				: value;
			currentArrayValues.push(unquoted);
			continue;
		}

		// Save any pending array
		if (currentArrayKey) {
			frontmatter.arrays[currentArrayKey] = currentArrayValues;
			currentArrayKey = null;
			currentArrayValues = [];
		}

		// Match key: value pattern
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			const key = match[1];
			let value = match[2].trim();

			// Check if value is inline array: [item1, item2] or []
			if (value.startsWith("[") && value.endsWith("]")) {
				const inner = value.slice(1, -1).trim();
				if (inner === "") {
					// Empty array []
					frontmatter.arrays[key] = [];
				} else {
					// Inline array with items
					frontmatter.arrays[key] = inner.split(",").map((v) => {
						const trimmed = v.trim();
						return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
							? trimmed.slice(1, -1)
							: trimmed;
					}).filter(Boolean);
				}
				continue;
			}

			// Check if value is empty (start of multi-line array)
			if (value === "") {
				currentArrayKey = key;
				currentArrayValues = [];
				continue;
			}

			// Remove quotes if present
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter.values[key] = value;
		}
	}

	// Save any pending array at end
	if (currentArrayKey) {
		frontmatter.arrays[currentArrayKey] = currentArrayValues;
	}

	return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "user" | "project", prefix = ""): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
			agents.push(...loadAgentsFromDir(fullPath, source, subPrefix));
			continue;
		}

		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		let content: string;
		try {
			content = fs.readFileSync(fullPath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		const fm = frontmatter.values; // Simple key-value pairs
		const fmArrays = frontmatter.arrays; // Array values

		if (!fm.name || !fm.description) {
			continue;
		}

		// Parse tools - can be comma-separated string or array
		let tools: string[] | undefined;
		if (fmArrays.tools) {
			tools = fmArrays.tools;
		} else if (fm.tools) {
			tools = fm.tools.split(",").map((t) => t.trim()).filter(Boolean);
		}

		const baseName = entry.name.replace(/\.md$/, "");
		const agentName = prefix ? `${prefix}/${baseName}` : fm.name;

		const systemPromptMode = fm["system-prompt-mode"] as "append" | "override" | undefined;

		// Warn if override mode with no tools - likely a configuration error
		if (systemPromptMode === "override" && (!tools || tools.length === 0)) {
			console.warn(`⚠️  Agent "${agentName}" uses system-prompt-mode: override but has no tools specified. It will have NO tools available.`);
		}

		// Parse extensions - can be single string, array, or empty array []
		let extensions: string | string[] | undefined;
		if ("extensions" in fmArrays) {
			// Array form (including empty array [])
			extensions = fmArrays.extensions;
		} else if (fm.extensions) {
			// Single string value
			extensions = fm.extensions;
		}

		// Parse skills - array or undefined
		// Empty array [] means skip discovery, undefined means discover
		let skills: string[] | undefined;
		if ("skills" in fmArrays) {
			skills = fmArrays.skills;
		}

		// Parse context-files - array or undefined
		// Empty array [] means skip discovery, undefined means discover
		let contextFiles: string[] | undefined;
		if ("context-files" in fmArrays) {
			contextFiles = fmArrays["context-files"];
		}

		// Validate extension paths exist (warn if not)
		if (extensions) {
			const agentDir = path.dirname(fullPath);
			const extPaths = Array.isArray(extensions) ? extensions : [extensions];
			for (const ext of extPaths) {
				const resolvedPath = path.isAbsolute(ext) ? ext : path.resolve(agentDir, ext);
				if (!fs.existsSync(resolvedPath)) {
					console.warn(`⚠️  Agent "${agentName}" references extension that doesn't exist: ${ext} (resolved: ${resolvedPath})`);
				}
			}
		}

		agents.push({
			name: agentName,
			description: fm.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: fm.model,
			systemPrompt: body,
			systemPromptMode: systemPromptMode === "override" ? "override" : undefined, // default is append
			source,
			filePath: fullPath,
			extensions,
			skills,
			contextFiles,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const OutputParams = Type.Object({
	ids: Type.Array(Type.String(), {
		description: "Worker IDs or labels to read (e.g. ['worker-04ea', 'scout', 'review'])",
		minItems: 1,
	}),
	coordDir: Type.Optional(Type.String({ description: "Coordination dir (defaults to PI_COORDINATION_DIR)" })),
	format: Type.Optional(
		Type.Union([Type.Literal("raw"), Type.Literal("json"), Type.Literal("stripped")], {
			description: "Output format: raw (default), json (structured), stripped (no ANSI)",
		}),
	),
});

type OutputParamsType = Static<typeof OutputParams>;

interface OutputEntry {
	id: string;
	path: string;
	lineCount: number;
	charCount: number;
}

interface OutputToolDetails {
	outputs: OutputEntry[];
	notFound?: string[];
	availableIds?: string[];
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function countLines(text: string): number {
	if (!text) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

function sanitizeLabel(label: string): string {
	return label.replace(/[^\w.-]+/g, "_");
}

function resolveCoordDir(param?: string): string | null {
	return param || process.env.PI_COORDINATION_DIR || null;
}

function listWorkerStates(coordDir: string): Array<{ id?: string; shortId?: string; identity?: string; artifactsDir?: string }> {
	try {
		return fs
			.readdirSync(coordDir)
			.filter((f) => f.startsWith("worker-") && f.endsWith(".json"))
			.map((f) => {
				try {
					const content = fs.readFileSync(path.join(coordDir, f), "utf-8");
					return JSON.parse(content);
				} catch {
					return null;
				}
			})
			.filter(Boolean) as Array<{ id?: string; shortId?: string; identity?: string; artifactsDir?: string }>;
	} catch {
		return [];
	}
}

function resolveWorkerOutputPath(
	coordDir: string,
	workerStates: Array<{ id?: string; shortId?: string; identity?: string; artifactsDir?: string }>,
	id: string,
): string | null {
	const match = workerStates.find((w) => w.id === id || w.shortId === id || w.identity === id);
	if (match?.id) {
		const outputsPath = path.join(coordDir, "outputs", `${match.id}.md`);
		if (fs.existsSync(outputsPath)) return outputsPath;
	}
	if (!match?.artifactsDir) return null;
	const artifactOutputPath = path.join(match.artifactsDir, "output.md");
	return fs.existsSync(artifactOutputPath) ? artifactOutputPath : null;
}

function resolveArtifactOutputPath(coordDir: string, id: string): string | null {
	const artifactsDir = path.join(coordDir, "artifacts");
	if (!fs.existsSync(artifactsDir)) return null;
	const prefix = sanitizeLabel(id);
	let entries: string[];
	try {
		entries = fs.readdirSync(artifactsDir);
	} catch {
		return null;
	}
	const candidates = entries
		.filter((entry) => entry.startsWith(prefix))
		.map((entry) => {
			const full = path.join(artifactsDir, entry);
			try {
				const stat = fs.statSync(full);
				return { dir: full, mtimeMs: stat.mtimeMs };
			} catch {
				return null;
			}
		})
		.filter(Boolean) as Array<{ dir: string; mtimeMs: number }>;

	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const c of candidates) {
		const outputPath = path.join(c.dir, "output.md");
		if (fs.existsSync(outputPath)) return outputPath;
	}
	return null;
}

function listAvailableIds(
	workerStates: Array<{ id?: string; shortId?: string; identity?: string }>,
	coordDir: string,
): string[] {
	const ids = new Set<string>();
	const uuidSuffix = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	for (const w of workerStates) {
		if (w.id) ids.add(w.id);
		if (w.shortId) ids.add(w.shortId);
		if (w.identity) ids.add(w.identity);
	}
	const artifactsDir = path.join(coordDir, "artifacts");
	if (fs.existsSync(artifactsDir)) {
		try {
			for (const entry of fs.readdirSync(artifactsDir)) {
				const label = entry.replace(uuidSuffix, "");
				if (label) ids.add(label);
			}
		} catch {}
	}
	return Array.from(ids).sort();
}

export function createCoordOutputTool(): ToolDefinition<typeof OutputParams, OutputToolDetails> {
	return {
		name: "coord_output",
		label: "CoordOutput",
		description: "Read full worker output by ID from a coordination session.",
		parameters: OutputParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			const typed = params as OutputParamsType;
			const coordDir = resolveCoordDir(typed.coordDir);
			if (!coordDir) {
				return {
					content: [{ type: "text", text: "Missing coordDir (pass coordDir or set PI_COORDINATION_DIR)" }],
					details: { outputs: [], notFound: typed.ids },
					isError: true,
				};
			}

			const workerStates = listWorkerStates(coordDir);
			const outputs: OutputEntry[] = [];
			const notFound: string[] = [];
			const format = typed.format ?? "raw";

			for (const id of typed.ids) {
				let outputPath: string | null = null;

				if (path.isAbsolute(id) || id.startsWith(".") || id.includes("/")) {
					const resolved = path.resolve(coordDir, id);
					if (fs.existsSync(resolved)) outputPath = resolved;
				}

				if (!outputPath) {
					outputPath = resolveWorkerOutputPath(coordDir, workerStates, id) || resolveArtifactOutputPath(coordDir, id);
				}

				if (!outputPath || !fs.existsSync(outputPath)) {
					notFound.push(id);
					continue;
				}

				const content = fs.readFileSync(outputPath, "utf-8");
				outputs.push({
					id,
					path: outputPath,
					lineCount: countLines(content),
					charCount: content.length,
				});
			}

			if (notFound.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Not found: ${notFound.join(", ")}\nAvailable: ${listAvailableIds(workerStates, coordDir).join(", ") || "(none)"}`,
						},
					],
					details: { outputs, notFound, availableIds: listAvailableIds(workerStates, coordDir) },
					isError: true,
				};
			}

			let contentText: string;
			if (format === "json") {
				contentText = JSON.stringify(
					outputs.map((o) => ({
						...o,
						content: fs.readFileSync(o.path, "utf-8"),
					})),
					null,
					2,
				);
			} else {
				const parts = outputs.map((o) => {
					let content = fs.readFileSync(o.path, "utf-8");
					if (format === "stripped") content = stripAnsi(content);
					if (outputs.length > 1) {
						return `=== ${o.id} (${o.lineCount} lines) ===\n${content}`;
					}
					return content;
				});
				contentText = parts.join("\n\n");
			}

			return {
				content: [{ type: "text", text: contentText }],
				details: { outputs },
			};
		},
	};
}

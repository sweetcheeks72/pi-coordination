import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
	".woff", ".woff2", ".ttf", ".eot", ".otf",
	".pdf", ".zip", ".tar", ".gz", ".rar",
	".mp3", ".mp4", ".wav", ".avi", ".mov",
	".exe", ".dll", ".so", ".dylib",
	".pyc", ".class", ".o", ".a",
]);

function estimateTokens(bytes: number): number {
	return Math.ceil(bytes / 4);
}

function isBinaryFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

function getLanguageFromPath(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	const langMap: Record<string, string> = {
		".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
		".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
		".java": "java", ".kt": "kotlin", ".scala": "scala",
		".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
		".cs": "csharp", ".fs": "fsharp",
		".swift": "swift", ".m": "objc",
		".php": "php", ".pl": "perl",
		".sh": "bash", ".bash": "bash", ".zsh": "zsh",
		".sql": "sql", ".graphql": "graphql",
		".html": "html", ".css": "css", ".scss": "scss", ".less": "less",
		".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
		".xml": "xml", ".md": "markdown", ".mdx": "mdx",
		".vue": "vue", ".svelte": "svelte",
	};
	return langMap[ext] || "";
}

function getGitFiles(cwd: string): string[] {
	try {
		const output = execSync("git ls-files --cached --others --exclude-standard", {
			cwd,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
		return output.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function isGitRepo(cwd: string): boolean {
	try {
		execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function globToRegex(pattern: string): RegExp {
	let regexStr = "";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				regexStr += ".*";
				i += 2;
				if (pattern[i] === "/") i++;
			} else {
				regexStr += "[^/]*";
				i++;
			}
		} else if (char === "?") {
			regexStr += "[^/]";
			i++;
		} else if (".+^${}()|[]\\".includes(char)) {
			regexStr += "\\" + char;
			i++;
		} else {
			regexStr += char;
			i++;
		}
	}
	return new RegExp("^" + regexStr + "$");
}

function matchesPatterns(filePath: string, patterns: string[]): boolean {
	if (patterns.length === 0) return true;
	return patterns.some(pattern => {
		if (pattern.includes("*") || pattern.includes("?")) {
			return globToRegex(pattern).test(filePath);
		}
		return filePath.startsWith(pattern) || filePath.includes("/" + pattern);
	});
}

interface FileInfo {
	path: string;
	tokens: number;
	bytes: number;
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/");
}

function scanDirectory(cwd: string, patterns: string[], ignore: string[], maxDepth: number): FileInfo[] {
	const files: FileInfo[] = [];
	const gitFiles = isGitRepo(cwd) ? new Set(getGitFiles(cwd)) : null;

	const walk = (dir: string, depth: number) => {
		if (depth > maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const relativePath = normalizePath(path.relative(cwd, fullPath));

			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (ignore.some(p => relativePath.startsWith(p) || entry.name === p)) continue;

			if (entry.isDirectory()) {
				walk(fullPath, depth + 1);
			} else if (entry.isFile()) {
				if (gitFiles && !gitFiles.has(relativePath)) continue;
				if (isBinaryFile(relativePath)) continue;
				if (!matchesPatterns(relativePath, patterns)) continue;

				try {
					const stats = fs.statSync(fullPath);
					files.push({
						path: relativePath,
						bytes: stats.size,
						tokens: estimateTokens(stats.size),
					});
				} catch {}
			}
		}
	};

	walk(cwd, 0);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function buildTree(files: FileInfo[]): string {
	const tree: Record<string, FileInfo | Record<string, unknown>> = {};

	for (const file of files) {
		const parts = file.path.split("/");
		let current = tree;
		for (let i = 0; i < parts.length - 1; i++) {
			if (!current[parts[i]]) current[parts[i]] = {};
			current = current[parts[i]] as Record<string, unknown>;
		}
		current[parts[parts.length - 1]] = file;
	}

	const lines: string[] = [];
	const render = (node: Record<string, unknown>, prefix: string, isLast: boolean, isRoot: boolean) => {
		const entries = Object.entries(node).sort(([a], [b]) => {
			const aIsDir = typeof node[a] === "object" && !("tokens" in (node[a] as object));
			const bIsDir = typeof node[b] === "object" && !("tokens" in (node[b] as object));
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return a.localeCompare(b);
		});

		entries.forEach(([name, value], idx) => {
			const last = idx === entries.length - 1;
			const connector = isRoot ? "" : (last ? "└── " : "├── ");
			const newPrefix = isRoot ? "" : prefix + (last ? "    " : "│   ");

			if (typeof value === "object" && "tokens" in value) {
				const f = value as FileInfo;
				const tokenStr = f.tokens >= 1000 ? `${(f.tokens / 1000).toFixed(1)}K` : String(f.tokens);
				lines.push(`${prefix}${connector}${name} (${tokenStr} tokens)`);
			} else {
				lines.push(`${prefix}${connector}${name}/`);
				render(value as Record<string, unknown>, newPrefix, last, false);
			}
		});
	};

	render(tree, "", true, true);
	return lines.join("\n");
}

function bundleContents(files: string[], cwd: string, maxTokens: number): { content: string; included: string[]; excluded: string[]; totalTokens: number } {
	const included: string[] = [];
	const excluded: string[] = [];
	let totalTokens = 0;
	const parts: string[] = [];

	for (const filePath of files) {
		const fullPath = path.join(cwd, filePath);
		let content: string;
		try {
			content = fs.readFileSync(fullPath, "utf-8");
		} catch {
			excluded.push(filePath);
			continue;
		}

		const tokens = estimateTokens(Buffer.byteLength(content, "utf-8"));
		if (totalTokens + tokens > maxTokens && included.length > 0) {
			excluded.push(filePath);
			continue;
		}

		const lang = getLanguageFromPath(filePath);
		parts.push(`File: ${filePath}\n\`\`\`${lang}\n${content}\n\`\`\``);
		included.push(filePath);
		totalTokens += tokens;
	}

	const content = parts.join("\n\n");
	return { content, included, excluded, totalTokens };
}

const ScanFilesParams = Type.Object({
	patterns: Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to filter files (default: all)" })),
	ignore: Type.Optional(Type.Array(Type.String(), { description: "Patterns to ignore" })),
	maxDepth: Type.Optional(Type.Number({ description: "Max directory depth (default: 20)" })),
});

const BundleFilesParams = Type.Object({
	files: Type.Array(Type.String(), { description: "File paths to bundle" }),
	maxTokens: Type.Optional(Type.Number({ description: "Max tokens to include (default: 100000)" })),
});

export function createBundleTools(cwd: string): ToolDefinition[] {
	return [
		{
			name: "scan_files",
			description: "Scan codebase and return file tree with token estimates. Use this first to understand the codebase structure before bundling.",
			parameters: ScanFilesParams,
			execute: async (_id, params) => {
				const patterns = (params as { patterns?: string[] }).patterns || [];
				const ignore = (params as { ignore?: string[] }).ignore || [];
				const maxDepth = (params as { maxDepth?: number }).maxDepth || 20;

				const files = scanDirectory(cwd, patterns, ignore, maxDepth);
				const tree = buildTree(files);
				const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);

				const byExtension: Record<string, number> = {};
				for (const f of files) {
					const ext = path.extname(f.path) || "(no ext)";
					byExtension[ext] = (byExtension[ext] || 0) + f.tokens;
				}

				const summary = {
					totalFiles: files.length,
					totalTokens,
					byExtension,
				};

				return {
					content: [{
						type: "text",
						text: `## File Tree (${files.length} files, ~${Math.round(totalTokens / 1000)}K tokens)\n\n${tree}\n\n## Summary by Extension\n${Object.entries(byExtension).sort((a, b) => b[1] - a[1]).map(([ext, tokens]) => `- ${ext}: ~${Math.round(tokens / 1000)}K tokens`).join("\n")}`,
					}],
					details: { tree, files, summary },
				};
			},
		},
		{
			name: "bundle_files",
			description: "Bundle specified files into a single output with their contents. Returns file contents in <file_contents> format.",
			parameters: BundleFilesParams,
			execute: async (_id, params) => {
				const files = (params as { files: string[] }).files;
				const maxTokens = (params as { maxTokens?: number }).maxTokens || 100000;

				const result = bundleContents(files, cwd, maxTokens);

				let summary = `Bundled ${result.included.length} files (~${Math.round(result.totalTokens / 1000)}K tokens)`;
				if (result.excluded.length > 0) {
					summary += `\n\nExcluded (budget exceeded): ${result.excluded.join(", ")}`;
				}

				return {
					content: [{
						type: "text",
						text: result.content ? `${summary}\n\n${result.content}` : summary,
					}],
					details: {
						included: result.included,
						excluded: result.excluded,
						totalTokens: result.totalTokens,
					},
				};
			},
		},
	];
}

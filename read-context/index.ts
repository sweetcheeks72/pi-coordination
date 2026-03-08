import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

const ReadContextParams = Type.Object({
	path: Type.String({ description: "Path to the context file (relative or absolute)" }),
	section: Type.Optional(
		Type.Union([Type.Literal("meta"), Type.Literal("file_map"), Type.Literal("file_contents"), Type.Literal("all")], {
			description: "Which section to read: 'meta', 'file_map', 'file_contents', or 'all' (default: 'all')",
		})
	),
});

type ReadContextParamsType = Static<typeof ReadContextParams>;

export interface ReadContextDetails {
	section: "meta" | "file_map" | "file_contents" | "all";
	bytesRead: number;
}

export function createReadContextTool(): ToolDefinition<typeof ReadContextParams, ReadContextDetails> {
	return {
		name: "read_context",
		label: "Read Context File",
		description:
			"Read a scout context file. Sections: 'meta' (scout analysis), 'file_map' (directory tree), 'file_contents' (code snippets), or 'all' (default). Use for large context files that would be truncated by normal read.",
		parameters: ReadContextParams,
		async execute(
			_toolCallId: string,
			params: ReadContextParamsType,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<ReadContextDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<ReadContextDetails>> {
			const { path: filePath, section = "all" } = params;

			const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);

			try {
				const content = await fs.readFile(absolutePath, "utf-8");

				if (section === "all") {
					return {
						content: [{ type: "text", text: content }],
						details: { section: "all", bytesRead: Buffer.byteLength(content, "utf-8") },
					};
				}

				const metaMatch = content.match(/<meta>([\s\S]*?)<\/meta>/);
				const fileMapMatch = content.match(/<file_map>([\s\S]*?)<\/file_map>/);
				const fileContentsMatch = content.match(/<file_contents>([\s\S]*?)<\/file_contents>/);

				if (section === "meta") {
					if (!metaMatch) {
						return {
							content: [{ type: "text", text: "No <meta> section found in context file." }],
							details: { section: "meta", bytesRead: 0 },
						};
					}
					const text = metaMatch[1].trim();
					return {
						content: [{ type: "text", text }],
						details: { section: "meta", bytesRead: Buffer.byteLength(text, "utf-8") },
					};
				}

				if (section === "file_map") {
					if (!fileMapMatch) {
						return {
							content: [{ type: "text", text: "No <file_map> section found in context file." }],
							details: { section: "file_map", bytesRead: 0 },
						};
					}
					const text = fileMapMatch[1].trim();
					return {
						content: [{ type: "text", text }],
						details: { section: "file_map", bytesRead: Buffer.byteLength(text, "utf-8") },
					};
				}

				if (section === "file_contents") {
					if (!fileContentsMatch) {
						return {
							content: [{ type: "text", text: "No <file_contents> section found in context file." }],
							details: { section: "file_contents", bytesRead: 0 },
						};
					}
					const text = fileContentsMatch[1].trim();
					return {
						content: [{ type: "text", text }],
						details: { section: "file_contents", bytesRead: Buffer.byteLength(text, "utf-8") },
					};
				}

				return {
					content: [{ type: "text", text: content }],
					details: { section: "all", bytesRead: Buffer.byteLength(content, "utf-8") },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error reading context file: ${message}` }],
					details: { section, bytesRead: 0 },
				};
			}
		},
	};
}

export default createReadContextTool;

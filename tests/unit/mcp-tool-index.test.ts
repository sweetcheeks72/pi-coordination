/**
 * Unit tests for coordinate/mcp-tool-index.ts
 *
 * Tests cover:
 *   1. buildToolIndex() — constructs index from MCP servers
 *   2. searchTools() — keyword + natural language matching
 *   3. buildCompactToolList() — compact context-efficient listing
 *   4. loadToolSchema() — lazy loading + caching
 *   5. handleSearchToolsCall() — synthetic search_tools handler
 */

import { describe, it, expect, vi } from "vitest";
import {
	buildToolIndex,
	searchTools,
	buildCompactToolList,
	loadToolSchema,
	handleSearchToolsCall,
	estimateTokens,
	logTokenSavings,
	SEARCH_TOOLS_TOOL,
	type MCPServer,
	type ToolIndex,
	type ToolIndexEntry,
} from "../../coordinate/mcp-tool-index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface TestTool {
	name: string;
	description: string;
	schema?: object;
}

function makeServer(id: string, tools: TestTool[]): MCPServer {
	return {
		id,
		async listTools() {
			return tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.schema,
			}));
		},
		async getToolSchema(toolName: string) {
			const tool = tools.find((t) => t.name === toolName);
			return tool?.schema ?? null;
		},
	};
}

const FILESYSTEM_TOOLS: TestTool[] = [
	{
		name: "read",
		description: "Read the contents of a file from the filesystem",
		schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "write",
		description: "Write content to a file on the filesystem",
		schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
	},
	{
		name: "find",
		description: "Search for files by glob pattern",
		schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
	},
	{
		name: "bash",
		description: "Execute bash commands in the current directory",
		schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
	{
		name: "grep",
		description: "Search file contents for a pattern using regular expressions",
		schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
	},
];

const BROWSER_TOOLS: TestTool[] = [
	{
		name: "screenshot",
		description: "Take a screenshot of the current browser page",
	},
	{
		name: "click",
		description: "Click an element on the browser page",
	},
];

// Pre-built index for tests that don't need buildToolIndex
function buildTestIndex(tools: TestTool[] = FILESYSTEM_TOOLS, serverId = "fs"): ToolIndex {
	const entries: ToolIndexEntry[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		serverId,
		schemaLoaded: Boolean(t.schema),
		schema: t.schema,
	}));
	return { entries, createdAt: new Date().toISOString(), serverIds: [serverId] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. searchTools — natural language matching
// ─────────────────────────────────────────────────────────────────────────────

describe("searchTools()", () => {
	it("returns top 5 results by relevance", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const results = searchTools(index, "list files directory");
		expect(results.length).toBeGreaterThan(0);
		expect(results.length).toBeLessThanOrEqual(5);
	});

	it("finds tools by exact tool name", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const results = searchTools(index, "bash");
		expect(results[0].name).toBe("bash");
	});

	it("finds tools by partial description match", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const results = searchTools(index, "search pattern");
		// Both grep (search file contents for pattern) and find (search for files by glob pattern) should match
		const names = results.map((r: ToolIndexEntry) => r.name);
		expect(names.some((n: string) => n === "grep" || n === "find")).toBe(true);
	});

	it("returns empty array when query yields no matches", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const results = searchTools(index, "xyzabc_no_match_possible");
		expect(results).toHaveLength(0);
	});

	it("returns up to 5 entries for broad query", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const results = searchTools(index, "file");
		expect(results.length).toBeLessThanOrEqual(5);
	});

	it("handles empty query by returning first 5 entries", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const results = searchTools(index, "");
		expect(results.length).toBeLessThanOrEqual(5);
	});

	it("is case-insensitive", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const lowerResults = searchTools(index, "bash");
		const upperResults = searchTools(index, "BASH");
		expect(lowerResults.map((r: ToolIndexEntry) => r.name)).toEqual(upperResults.map((r: ToolIndexEntry) => r.name));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildCompactToolList — context-efficient listing
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCompactToolList()", () => {
	it("includes all tool names in the output", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const compact = buildCompactToolList(index);
		for (const tool of FILESYSTEM_TOOLS) {
			expect(compact).toContain(tool.name);
		}
	});

	it("mentions search_tools for discoverability", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const compact = buildCompactToolList(index);
		expect(compact).toContain("search_tools");
	});

	it("is significantly smaller than full schema JSON", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const compact = buildCompactToolList(index);
		const fullJSON = JSON.stringify(FILESYSTEM_TOOLS.map((t: TestTool) => ({ name: t.name, description: t.description, schema: t.schema })), null, 2);
		// Compact should be at least 50% smaller
		expect(compact.length).toBeLessThan(fullJSON.length * 0.5);
	});

	it("handles empty index gracefully", () => {
		const index: ToolIndex = { entries: [], createdAt: new Date().toISOString(), serverIds: [] };
		const compact = buildCompactToolList(index);
		expect(compact).toBeTruthy();
		expect(compact).not.toContain("undefined");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. buildToolIndex — constructs index from MCP servers
// ─────────────────────────────────────────────────────────────────────────────

describe("buildToolIndex()", () => {
	it("builds index from a single server", async () => {
		const server = makeServer("fs", FILESYSTEM_TOOLS);
		const index = await buildToolIndex([server]);
		expect(index.entries).toHaveLength(FILESYSTEM_TOOLS.length);
		expect(index.serverIds).toContain("fs");
	});

	it("builds index from multiple servers", async () => {
		const fsServer = makeServer("fs", FILESYSTEM_TOOLS);
		const browserServer = makeServer("browser", BROWSER_TOOLS);
		const index = await buildToolIndex([fsServer, browserServer]);
		expect(index.entries).toHaveLength(FILESYSTEM_TOOLS.length + BROWSER_TOOLS.length);
		expect(index.serverIds).toEqual(["fs", "browser"]);
	});

	it("marks entries as schemaLoaded when schema is provided", async () => {
		const server = makeServer("fs", FILESYSTEM_TOOLS);
		const index = await buildToolIndex([server]);
		const readEntry = index.entries.find((e: ToolIndexEntry) => e.name === "read");
		expect(readEntry?.schemaLoaded).toBe(true);
		expect(readEntry?.schema).toBeDefined();
	});

	it("marks entries as NOT schemaLoaded when schema is absent", async () => {
		const server = makeServer("browser", BROWSER_TOOLS); // BROWSER_TOOLS have no schema
		const index = await buildToolIndex([server]);
		const screenshotEntry = index.entries.find((e: ToolIndexEntry) => e.name === "screenshot");
		expect(screenshotEntry?.schemaLoaded).toBe(false);
	});

	it("handles server listTools() failure gracefully", async () => {
		const brokenServer: MCPServer = {
			id: "broken",
			async listTools() {
				throw new Error("Server unavailable");
			},
		};
		const goodServer = makeServer("good", FILESYSTEM_TOOLS.slice(0, 2));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const index = await buildToolIndex([brokenServer, goodServer]);
		expect(index.entries).toHaveLength(2); // only good server's tools
		expect(index.serverIds).toContain("broken");
		warnSpy.mockRestore();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. loadToolSchema — lazy loading + caching
// ─────────────────────────────────────────────────────────────────────────────

describe("loadToolSchema()", () => {
	it("returns null for unknown tool", async () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const server = makeServer("fs", FILESYSTEM_TOOLS);
		const schema = await loadToolSchema(index, "nonexistent_tool", server);
		expect(schema).toBeNull();
	});

	it("returns cached schema without calling server again", async () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const server = makeServer("fs", FILESYSTEM_TOOLS);
		const getToolSchemaSpy = vi.spyOn(server, "getToolSchema");

		// First call — schema is already cached from buildTestIndex
		const schema = await loadToolSchema(index, "read", server);
		expect(schema).toBeDefined();
		// Should NOT have called getToolSchema since it was already loaded
		expect(getToolSchemaSpy).not.toHaveBeenCalled();
	});

	it("lazy-loads schema when not pre-loaded", async () => {
		// Create index WITHOUT pre-loaded schemas
		const entries: ToolIndexEntry[] = FILESYSTEM_TOOLS.map((t: TestTool) => ({
			name: t.name,
			description: t.description,
			serverId: "fs",
			schemaLoaded: false,
		}));
		const index: ToolIndex = { entries, createdAt: new Date().toISOString(), serverIds: ["fs"] };

		const server = makeServer("fs", FILESYSTEM_TOOLS); // server has schemas
		const schema = await loadToolSchema(index, "bash", server);
		expect(schema).toBeDefined();
		expect(schema).toHaveProperty("type", "object");

		// Verify the entry was mutated/cached
		const entry = index.entries.find((e: ToolIndexEntry) => e.name === "bash");
		expect(entry?.schemaLoaded).toBe(true);
		expect(entry?.schema).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. handleSearchToolsCall — synthetic search_tools tool handler
// ─────────────────────────────────────────────────────────────────────────────

describe("handleSearchToolsCall()", () => {
	it("returns tool names and descriptions in the result", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const result = handleSearchToolsCall(index, "bash command");
		expect(result).toContain("bash");
		expect(result).toContain("Execute bash commands");
	});

	it("returns a fallback message when no tools match", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const result = handleSearchToolsCall(index, "xyzabc_no_match");
		expect(result).toContain("No tools found matching");
		expect(result).toContain("Available tool names:");
	});

	it("includes schema info for pre-loaded tools", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const result = handleSearchToolsCall(index, "read file");
		expect(result).toContain("read");
		// Schema should be shown
		expect(result).toContain("Schema:");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Token savings / SEARCH_TOOLS_TOOL shape
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateTokens()", () => {
	it("estimates tokens as approximately chars / 4", () => {
		const text = "a".repeat(400);
		expect(estimateTokens(text)).toBe(100);
	});
});

describe("SEARCH_TOOLS_TOOL", () => {
	it("has correct name", () => {
		expect(SEARCH_TOOLS_TOOL.name).toBe("search_tools");
	});

	it("has required query parameter", () => {
		expect(SEARCH_TOOLS_TOOL.inputSchema.required).toContain("query");
		expect(SEARCH_TOOLS_TOOL.inputSchema.properties.query.type).toBe("string");
	});
});

describe("logTokenSavings()", () => {
	it("returns a positive savings count when full schemas are large", () => {
		const index = buildTestIndex(FILESYSTEM_TOOLS);
		const bigJSON = JSON.stringify(FILESYSTEM_TOOLS.map((t: TestTool) => ({
			name: t.name,
			description: t.description,
			schema: t.schema,
			// Inflate to simulate large schemas
			extra: "x".repeat(500),
		})));
		const savings = logTokenSavings(index, bigJSON);
		expect(savings).toBeGreaterThan(0);
	});
});

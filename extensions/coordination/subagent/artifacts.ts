import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export interface ArtifactPaths {
	dir: string;
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

function sanitizeLabel(label: string): string {
	return label.replace(/[^\w.-]+/g, "_");
}

export function resolveArtifactsBaseDir(explicitBase?: string): string {
	if (explicitBase) return explicitBase;

	const coordDir = process.env.PI_COORDINATION_DIR;
	if (coordDir) return path.join(coordDir, "artifacts");

	const sessionDir = process.env.PI_SESSION_DIR;
	if (sessionDir) return path.join(sessionDir, "artifacts");

	return path.join(os.tmpdir(), "pi-artifacts");
}

export function createArtifactPaths(
	label: string,
	runId: string,
	baseDir?: string,
): ArtifactPaths {
	const base = resolveArtifactsBaseDir(baseDir);
	const dir = path.join(base, sanitizeLabel(`${label}-${runId}`));
	fs.mkdirSync(dir, { recursive: true });

	return {
		dir,
		inputPath: path.join(dir, "input.md"),
		outputPath: path.join(dir, "output.md"),
		jsonlPath: path.join(dir, "events.jsonl"),
		metadataPath: path.join(dir, "metadata.json"),
	};
}

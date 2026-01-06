import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBundleTools } from "../../tools/bundle-files/index.js";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const tools = createBundleTools(cwd);

	for (const tool of tools) {
		pi.registerTool(tool);
	}
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReadContextTool } from "../../tools/read-context/index.js";

export default function registerPlannerExtension(pi: ExtensionAPI): void {
	pi.registerTool(createReadContextTool());
}

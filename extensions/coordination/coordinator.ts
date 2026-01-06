import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCoordinatorTools } from "./coordinate/coordinator-tools/index.js";

export default function registerCoordinatorExtension(pi: ExtensionAPI): void {
	registerCoordinatorTools(pi);
}

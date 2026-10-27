import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryHooks } from "./memory.ts";

export default function memory(pi: ExtensionAPI) {
  registerMemoryHooks(pi, getAgentDir());
}

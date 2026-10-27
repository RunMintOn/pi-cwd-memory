import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const promptFile = new URL("./memory-prompt.md", import.meta.url);

export function registerMemoryHooks(pi: ExtensionAPI, agentDir: string) {
  let snapshot: { directory: string; instructions: string; index: string } | undefined;

  pi.on("session_start", async (_event, ctx) => {
    snapshot = undefined;
    const cwdPath = resolve(ctx.cwd);
    const cwdId = `--${cwdPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const directory = join(agentDir, "memory", cwdId);
    await mkdir(directory, { recursive: true });

    const promptTemplate = await readFile(promptFile, "utf8");
    const indexPath = join(directory, "MEMORY.md");
    let index = "";
    try {
      index = await readFile(indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    snapshot = {
      directory,
      instructions: promptTemplate.replace("{{MEMORY_DIR}}", directory + sep),
      index: index
        ? `Contents of ${indexPath} (user's auto-memory, persists across conversations):\n\n${index}`
        : "",
    };
  });

  pi.on("before_agent_start", (event) => {
    if (!snapshot) return;
    // Reuse the session snapshot so disk changes cannot invalidate the prompt prefix.
    const sections = event.systemPromptOptions.sections;
    sections.memory = snapshot.instructions;
    if (snapshot.index) {
      sections.memory_index = snapshot.index;
    } else {
      delete sections.memory_index;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!snapshot || event.toolName !== "read" || event.isError) return;
    if (typeof event.input.path !== "string") return;
    let path = event.input.path;
    if (path.startsWith("@")) path = path.slice(1);
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    const absolutePath = resolve(ctx.cwd, path);
    if (!absolutePath.startsWith(snapshot.directory + sep)) return;

    const firstText = event.content.findIndex((block) => block.type === "text");
    if (firstText === -1) return;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(absolutePath)).mtimeMs;
    } catch {
      // An optional reminder must not turn a successful read into an error.
      return;
    }
    const days = Math.floor((Date.now() - mtimeMs) / 86_400_000);
    if (days <= 1) return;

    const reminder = `<system-reminder>This memory is ${days} days old. `
      + "Memories are point-in-time observations, not live state — "
      + "claims about code behavior or file:line citations may be outdated. "
      + "Verify against current code before asserting as fact.</system-reminder>\n";
    return {
      content: event.content.map((block, index) =>
        block.type === "text" && index === firstText
          ? { ...block, text: reminder + block.text }
          : block),
      // Codemode receives structuredContent rather than the model-facing text.
      structuredContent: typeof event.structuredContent === "string"
        ? reminder + event.structuredContent
        : event.structuredContent,
    };
  });
}

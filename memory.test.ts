import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { registerMemoryHooks } from "./memory.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { agentDir: join(root, "agent"), cwd: join(root, "project") };
}

function extension(agentDir: string) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as ExtensionAPI;
  registerMemoryHooks(pi, agentDir);
  assert.deepEqual([...handlers.keys()], ["session_start", "before_agent_start", "tool_result"]);

  return {
    async start(cwd: string) {
      await handlers.get("session_start")!({ type: "session_start" }, { cwd });
    },
    async inject(sections: Record<string, string> = {}) {
      await handlers.get("before_agent_start")!({
        type: "before_agent_start",
        systemPromptOptions: { sections },
      });
      return sections;
    },
    async toolResult(event: ToolResultEvent, cwd: string) {
      return await handlers.get("tool_result")!(event, { cwd }) as ToolResultEventResult | undefined;
    },
  };
}

function readEvent(path: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: "read-1",
    input: { path },
    content: [{ type: "text", text: "ORIGINAL_READ_CONTENT" }],
    structuredContent: "ORIGINAL_READ_CONTENT",
    details: undefined,
    isError: false,
  };
}

function memoryDirectory(sections: Record<string, string>) {
  const match = sections.memory.match(/persistent file-based memory at `([^`]+)`/);
  assert.ok(match, "The original prompt must contain the absolute memory directory");
  return match[1];
}

test("startup creates only the directory and expands the prompt path placeholder", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const runtime = extension(agentDir);
  await runtime.start(cwd);
  const sections = await runtime.inject({ unrelated: "leave this unchanged" });
  const directory = memoryDirectory(sections);

  assert.ok(directory.startsWith(join(agentDir, "memory") + "/"));
  assert.deepEqual(await readdir(directory), []);
  assert.equal(sections.unrelated, "leave this unchanged");
  assert.equal(sections.memory_index, undefined);

  const original = await readFile(new URL("./memory-prompt.md", import.meta.url), "utf8");
  const [before, after, unexpected] = original.split("{{MEMORY_DIR}}");
  assert.equal(unexpected, undefined);
  assert.ok(after);
  assert.equal(sections.memory, before + directory + after);
  assert.ok(!sections.memory.includes("{{MEMORY_DIR}}"));
  assert.ok(sections.memory.includes("with the `write` / `apply_patch` tools"));
});

test("memory directory uses pi's readable cwd encoding", async (t) => {
  const { agentDir } = await fixture(t);
  const runtime = extension(agentDir);
  await runtime.start("/Users/example/project");

  assert.equal(
    memoryDirectory(await runtime.inject()),
    join(agentDir, "memory", "--Users-example-project--") + "/",
  );
});

test("index is a session snapshot, refreshed only on session_start", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const runtime = extension(agentDir);
  await runtime.start(cwd);
  const empty = await runtime.inject();
  const directory = memoryDirectory(empty);
  const indexPath = join(directory, "MEMORY.md");
  const firstIndex = "- [Preference](preference.md) — user preference\n".repeat(300);
  await writeFile(indexPath, firstIndex);
  await writeFile(join(directory, "preference.md"), "BODY_MUST_NOT_BE_PRELOADED");

  assert.deepEqual(await runtime.inject(), empty, "A new index must not alter the active snapshot");
  await runtime.start(cwd);
  const loaded = await runtime.inject();
  assert.equal(
    loaded.memory_index,
    `Contents of ${indexPath} (user's auto-memory, persists across conversations):\n\n${firstIndex}`,
    "Load the entire index with its absolute source path",
  );
  assert.equal(await readFile(indexPath, "utf8"), firstIndex, "Do not add the header to the disk file");
  assert.ok(!Object.values(loaded).some((value) => value.includes("BODY_MUST_NOT_BE_PRELOADED")));

  await writeFile(indexPath, "- [Changed](changed.md) — changed on disk\n");
  assert.deepEqual(await runtime.inject(), loaded, "File changes must not change the active context");
  await rm(indexPath);
  assert.deepEqual(await runtime.inject(), loaded, "Injection must not re-read the deleted index");

  await runtime.start(cwd);
  const refreshed = await runtime.inject({ memory_index: firstIndex });
  assert.equal(refreshed.memory_index, undefined, "Do not retain a missing index after reinitialization");
});

test("the same cwd reuses memory across runtimes; different cwds remain isolated", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const first = extension(agentDir);
  await first.start(cwd);
  const firstDirectory = memoryDirectory(await first.inject());
  await writeFile(join(firstDirectory, "MEMORY.md"), "ONLY_FOR_FIRST_CWD\n");

  const resumed = extension(agentDir);
  await resumed.start(cwd);
  const same = await resumed.inject();
  assert.equal(memoryDirectory(same), firstDirectory);
  assert.equal(
    same.memory_index,
    `Contents of ${join(firstDirectory, "MEMORY.md")} (user's auto-memory, persists across conversations):\n\nONLY_FOR_FIRST_CWD\n`,
  );

  await resumed.start(join(cwd, "child"));
  const child = await resumed.inject();
  assert.notEqual(memoryDirectory(child), firstDirectory);
  assert.equal(child.memory_index, undefined);
  assert.deepEqual(await readdir(memoryDirectory(child)), []);
});

test("index read failures other than a missing file are not treated as an empty index", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const runtime = extension(agentDir);
  await runtime.start(cwd);
  const directory = memoryDirectory(await runtime.inject());
  await mkdir(join(directory, "MEMORY.md"));

  await assert.rejects(runtime.start(cwd), { code: "EISDIR" });
  assert.deepEqual(await runtime.inject(), {}, "A failed initialization must not reuse the old snapshot");
});

test("old-memory reminders start at 48 hours and reach both text and structured read results", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const runtime = extension(agentDir);
  await runtime.start(cwd);
  const directory = memoryDirectory(await runtime.inject());
  const path = join(directory, "preference.md");
  await writeFile(path, "ORIGINAL_READ_CONTENT");
  const now = Date.UTC(2026, 9, 27, 12);
  t.mock.method(Date, "now", () => now);

  for (const { seconds, days } of [
    { seconds: 86_400, days: undefined },
    { seconds: 172_799, days: undefined },
    { seconds: 172_800, days: 2 },
    { seconds: 259_200, days: 3 },
  ]) {
    const modified = now / 1000 - seconds;
    await utimes(path, modified, modified);
    const event = readEvent(path);
    const result = await runtime.toolResult(event, cwd);
    if (days === undefined) {
      assert.equal(result, undefined, `${seconds} seconds old must not trigger a reminder`);
    } else {
      const reminder = `<system-reminder>This memory is ${days} days old. `
        + "Memories are point-in-time observations, not live state — "
        + "claims about code behavior or file:line citations may be outdated. "
        + "Verify against current code before asserting as fact.</system-reminder>\n";
      assert.deepEqual(result?.content, [{ type: "text", text: reminder + "ORIGINAL_READ_CONTENT" }]);
      assert.equal(result?.structuredContent, reminder + "ORIGINAL_READ_CONTENT");
      assert.equal((await stat(path)).mtimeMs, modified * 1000, "Annotating must not modify the file");
    }
    assert.deepEqual(event.content, [{ type: "text", text: "ORIGINAL_READ_CONTENT" }]);
    assert.equal(event.structuredContent, "ORIGINAL_READ_CONTENT", "Do not mutate the original result");
  }
});

test("reminders apply only to successful reads in the active memory directory", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const runtime = extension(agentDir);
  await runtime.start(cwd);
  const directory = memoryDirectory(await runtime.inject());
  const memoryPath = join(directory, "preference.md");
  const outsidePath = join(agentDir, "ordinary.md");
  const siblingPath = join(directory.slice(0, -1) + "-other", "preference.md");
  const now = Date.UTC(2026, 9, 27, 12);
  const modified = now / 1000 - 259_200;
  t.mock.method(Date, "now", () => now);
  await mkdir(join(siblingPath, ".."), { recursive: true });
  for (const path of [memoryPath, outsidePath, siblingPath]) {
    await writeFile(path, "ORIGINAL_READ_CONTENT");
    await utimes(path, modified, modified);
  }

  assert.equal(await runtime.toolResult(readEvent(outsidePath), cwd), undefined);
  assert.equal(await runtime.toolResult(readEvent(siblingPath), cwd), undefined);
  assert.equal(await runtime.toolResult({ ...readEvent(memoryPath), isError: true }, cwd), undefined);
  assert.equal(await runtime.toolResult({ ...readEvent(memoryPath), toolName: "write" }, cwd), undefined);
  assert.equal(await runtime.toolResult(readEvent(join(directory, "missing.md")), cwd), undefined);

  const relativeResult = await runtime.toolResult(readEvent(relative(cwd, memoryPath)), cwd);
  assert.ok(relativeResult?.content?.[0].type === "text");
  assert.ok(relativeResult.content[0].text.startsWith("<system-reminder>This memory is 3 days old."));

  await runtime.start(join(cwd, "child"));
  assert.equal(await runtime.toolResult(readEvent(memoryPath), cwd), undefined);
});

test("manual index reads can warn without modifying the injected session snapshot", async (t) => {
  const { agentDir, cwd } = await fixture(t);
  const runtime = extension(agentDir);
  await runtime.start(cwd);
  const indexPath = join(memoryDirectory(await runtime.inject()), "MEMORY.md");
  await writeFile(indexPath, "- [Preference](preference.md) — preference\n");
  const now = Date.UTC(2026, 9, 27, 12);
  const modified = now / 1000 - 259_200;
  await utimes(indexPath, modified, modified);
  t.mock.method(Date, "now", () => now);
  await runtime.start(cwd);
  const snapshot = await runtime.inject();
  assert.ok(!snapshot.memory_index.includes("<system-reminder>"));

  const event = readEvent(indexPath);
  event.parentToolCallId = "codemode-1";
  const result = await runtime.toolResult(event, cwd);
  assert.ok(result?.content?.[0].type === "text");
  assert.ok(result.content[0].text.startsWith("<system-reminder>This memory is 3 days old."));
  assert.deepEqual(await runtime.inject(), snapshot);
});

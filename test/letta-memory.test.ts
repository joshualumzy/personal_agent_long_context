import assert from "node:assert/strict";
import { test } from "node:test";
import { LettaMemoryProvider } from "../src/adapters/letta-memory.js";
import { CONSENT_POLICY_VERSION } from "../src/domain.js";

test("auto-approves ingestion tools only inside the agent Memory directory", async () => {
  let capturedOptions: Record<string, unknown> | undefined;
  const fakeSession = {
    async getDeviceStatus() {
      return { memoryDirectory: "/srv/letta/memory" };
    },
    async send() {},
    async *stream() {
      yield { type: "result", success: true };
    },
    close() {},
  };
  const fakeClient = {
    agents: {
      async list() {
        return [{ id: "agent-1" }];
      },
    },
    resumeSession(_agentId: string, options: Record<string, unknown>) {
      capturedOptions = options;
      return fakeSession;
    },
    async close() {},
  };
  const provider = new LettaMemoryProvider({ url: "http://127.0.0.1:4500" });
  Object.defineProperty(provider, "client", { value: fakeClient });

  await provider.ingest({
    userId: "demo-user",
    sourceId: "voice-note-001",
    recordedAt: "2026-09-19T08:00:00.000Z",
    receivedAt: "2026-09-19T08:01:00.000Z",
    transcript: "My preferred tea is jasmine.",
    attestation: "uploader_only_identifiable_speaker",
    policyVersion: CONSENT_POLICY_VERSION,
    correlationId: "corr-test-001",
  });

  assert.equal(capturedOptions?.permissionMode, "strict");
  const canUseTool = capturedOptions?.canUseTool as (
    toolName: string,
    input: Record<string, unknown>,
  ) => { behavior: string };
  assert.equal(
    canUseTool("Write", { file_path: "/srv/letta/memory/context.md" }).behavior,
    "allow",
  );
  assert.equal(
    canUseTool("LS", { path: "$MEMORY_DIR" }).behavior,
    "allow",
  );
  assert.equal(
    canUseTool("Write", { file_path: "/tmp/outside-memory.md" }).behavior,
    "deny",
  );

  // Discovery tools resolve to the Memory directory on their own. Denying a
  // path-less call makes the agent retry it forever instead of ingesting.
  assert.equal(canUseTool("Glob", { pattern: "**/*.md" }).behavior, "allow");
  assert.equal(canUseTool("LS", {}).behavior, "allow");
  assert.equal(canUseTool("Grep", { pattern: "dentist" }).behavior, "allow");

  // A write still needs an explicit path inside the Memory directory.
  assert.equal(canUseTool("Write", {}).behavior, "deny");
  assert.equal(canUseTool("Bash", { command: "ls" }).behavior, "deny");
});

test("does not hide non-missing inspection errors whose path contains enoent", async () => {
  const fakeSession = {
    async getDeviceStatus() {
      return { memoryDirectory: "/srv/letta/memory" };
    },
    async send() {},
    async *stream() {
      yield {
        type: "tool_call",
        toolCallId: "failed-read",
        toolName: "Read",
        toolInput: { file_path: "/srv/letta/memory/enoent.md" },
        uuid: "message-1",
      };
      yield {
        type: "tool_result",
        toolCallId: "failed-read",
        content: "Permission denied: /srv/letta/memory/enoent.md",
        isError: true,
        uuid: "message-2",
      };
      yield { type: "result", success: true };
    },
    close() {},
  };
  const fakeClient = {
    agents: {
      async list() {
        return [{ id: "agent-1" }];
      },
    },
    resumeSession() {
      return fakeSession;
    },
    async close() {},
  };
  const provider = new LettaMemoryProvider({ url: "http://127.0.0.1:4500" });
  Object.defineProperty(provider, "client", { value: fakeClient });

  await assert.rejects(
    provider.inspect("demo-user"),
    /Letta could not read Memory file enoent\.md/,
  );
});

test("inspects MemFS files when the App Server agent response has no blocks", async () => {
  const sessionOptions: unknown[] = [];
  const fakeSession = {
    async getDeviceStatus() {
      return { memoryDirectory: "/srv/letta/memory" };
    },
    async send() {},
    async *stream() {
      yield {
        type: "tool_call",
        toolCallId: "missing-read",
        toolName: "Read",
        toolInput: { file_path: "/srv/letta/memory/index.md" },
        uuid: "message-0",
      };
      yield {
        type: "tool_result",
        toolCallId: "missing-read",
        content: "File does not exist: /srv/letta/memory/index.md",
        isError: true,
        uuid: "message-0-result",
      };
      yield {
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "Read",
        toolInput: {
          file_path: "/srv/letta/memory/personal-context/voice-note-001.md",
        },
        uuid: "message-1",
      };
      yield {
        type: "tool_result",
        toolCallId: "read-1",
        content: [
          "1\t---",
          "2\tdescription: A retained preference.",
          "3\t---",
          "4\t",
          "5\t# Preferences",
          "6\t- Tea: jasmine",
          "7\t",
        ].join("\n"),
        isError: false,
        uuid: "message-2",
      };
      yield {
        type: "tool_call",
        toolCallId: "read-human",
        toolName: "Read",
        toolInput: { file_path: "/srv/letta/memory/system/human.md" },
        uuid: "message-3",
      };
      yield {
        type: "tool_result",
        toolCallId: "read-human",
        content: [
          "1\t---",
          "2\tdescription: Core user context retained by Letta.",
          "3\t---",
          "4\t",
          "5\tPreferred tea: jasmine",
          "6\t",
        ].join("\n"),
        isError: false,
        uuid: "message-4",
      };
      yield {
        type: "result",
        success: true,
      };
    },
    close() {},
  };
  const fakeClient = {
    agents: {
      async list() {
        return [{ id: "agent-1" }];
      },
      async retrieve() {
        return { id: "agent-1" };
      },
    },
    resumeSession(_agentId: string, options: unknown) {
      sessionOptions.push(options);
      return fakeSession;
    },
    async close() {},
  };

  const provider = new LettaMemoryProvider({ url: "http://127.0.0.1:4500" });
  Object.defineProperty(provider, "client", { value: fakeClient });

  const inspection = await provider.inspect("demo-user");

  assert.deepEqual(inspection, {
    userId: "demo-user",
    items: [
      {
        label: "personal-context/voice-note-001.md",
        content: "# Preferences\n- Tea: jasmine\n",
        description: "A retained preference.",
      },
      {
        label: "system/human.md",
        content: "Preferred tea: jasmine\n",
        description: "Core user context retained by Letta.",
      },
    ],
  });
  assert.equal(sessionOptions.length, 1);
  assert.deepEqual(
    (sessionOptions[0] as { allowedTools: string[] }).allowedTools,
    ["Read", "LS", "Glob", "Grep"],
  );
});

test("answers from the user's own agent and reports the Memory files it read", async () => {
  const sessionOptions: unknown[] = [];
  const sent: { prompt: string; options?: Record<string, unknown> }[] = [];
  const fakeSession = {
    async getDeviceStatus() {
      return { memoryDirectory: "/srv/letta/memory" };
    },
    async send(prompt: string, options?: Record<string, unknown>) {
      sent.push({ prompt, ...(options ? { options } : {}) });
    },
    async *stream() {
      yield {
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "Read",
        toolInput: {
          file_path: "/srv/letta/memory/personal-context/voice-note-001.md",
        },
        uuid: "message-1",
      };
      yield {
        type: "tool_result",
        toolCallId: "read-1",
        content: [
          "1\tsource_id: voice-note-001",
          "2\t- Plans the week on Sunday evening.",
          "3\tsource_id: voice-note-002",
          "4\t- Confirmed on Sunday evening again.",
        ].join("\n"),
        isError: false,
        uuid: "message-2",
      };
      yield {
        type: "assistant",
        content: "Let me read your ",
        uuid: "message-0a",
        runId: "run-7",
      };
      yield {
        type: "assistant",
        content: "Memory files first.",
        uuid: "message-0b",
        runId: "run-7",
      };
      yield {
        type: "tool_call",
        toolCallId: "read-2",
        toolName: "Read",
        toolInput: { file_path: "/srv/letta/memory/system/human.md" },
        uuid: "message-2a",
      };
      yield {
        type: "tool_result",
        toolCallId: "read-2",
        content: "1\tPrefers a quiet week.",
        isError: false,
        uuid: "message-2b",
      };
      for (const delta of ["You plan", " the week on", " Sunday evening."]) {
        yield { type: "assistant", content: delta, uuid: "message-3", runId: "run-7" };
      }
      yield {
        type: "result",
        success: true,
        runIds: ["run-7"],
        result: "\n\nYou plan the week on Sunday evening.",
      };
    },
    close() {},
  };
  const fakeClient = {
    agents: {
      async list() {
        return [{ id: "agent-1" }];
      },
    },
    resumeSession(_agentId: string, options: unknown) {
      sessionOptions.push(options);
      return fakeSession;
    },
    async close() {},
  };
  const provider = new LettaMemoryProvider({ url: "http://127.0.0.1:4500" });
  Object.defineProperty(provider, "client", { value: fakeClient });

  const result = await provider.ask({
    userId: "demo-user",
    question: "When do I plan my week?",
    correlationId: "corr-test-002",
    receivedAt: "2026-09-19T08:02:00.000Z",
  });

  assert.deepEqual(result, {
    answer: "You plan the week on Sunday evening.",
    runRef: "run-7",
    sources: [
      { sourceId: "voice-note-001", label: "personal-context/voice-note-001.md" },
      { sourceId: "voice-note-002", label: "personal-context/voice-note-001.md" },
    ],
  });
  assert.deepEqual(
    (sessionOptions[0] as { allowedTools: string[] }).allowedTools,
    ["Read", "LS", "Glob", "Grep"],
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.prompt, /When do I plan my week\?/);
});

test("answers without sources when the user has no agent yet", async () => {
  let sessionsOpened = 0;
  const fakeClient = {
    agents: {
      async list() {
        return [];
      },
    },
    resumeSession() {
      sessionsOpened += 1;
      throw new Error("no session should be opened for an unknown user");
    },
    async close() {},
  };
  const provider = new LettaMemoryProvider({ url: "http://127.0.0.1:4500" });
  Object.defineProperty(provider, "client", { value: fakeClient });

  const result = await provider.ask({
    userId: "unknown-user",
    question: "When do I plan my week?",
    correlationId: "corr-test-003",
    receivedAt: "2026-09-19T08:03:00.000Z",
  });

  assert.equal(sessionsOpened, 0);
  assert.deepEqual(result.sources, []);
  assert.equal(result.runRef, undefined);
  assert.match(result.answer, /no Memory/i);
});

test("fails loudly when the answering run does not complete", async () => {
  const fakeSession = {
    async getDeviceStatus() {
      return { memoryDirectory: "/srv/letta/memory" };
    },
    async send() {},
    async *stream() {
      yield {
        type: "error",
        message: "model provider rejected the request",
        stopReason: "llm_api_error",
      };
    },
    close() {},
  };
  const fakeClient = {
    agents: {
      async list() {
        return [{ id: "agent-1" }];
      },
    },
    resumeSession() {
      return fakeSession;
    },
    async close() {},
  };
  const provider = new LettaMemoryProvider({ url: "http://127.0.0.1:4500" });
  Object.defineProperty(provider, "client", { value: fakeClient });

  await assert.rejects(
    provider.ask({
      userId: "demo-user",
      question: "When do I plan my week?",
      correlationId: "corr-test-004",
      receivedAt: "2026-09-19T08:04:00.000Z",
    }),
    /Letta could not answer/,
  );
});

test("drops narration and reassembles token deltas when the run reports no result text", async () => {
  const fakeSession = {
    async getDeviceStatus() {
      return { memoryDirectory: "/srv/letta/memory" };
    },
    async send() {},
    async *stream() {
      for (const delta of ["Let me check", " your Memory."]) {
        yield { type: "assistant", content: delta, uuid: "narration" };
      }
      yield {
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "Read",
        toolInput: { file_path: "/srv/letta/memory/personal-context/note.md" },
        uuid: "message-1",
      };
      yield {
        type: "tool_result",
        toolCallId: "read-1",
        content: "1\tsource_id: voice-note-009",
        isError: false,
        uuid: "message-2",
      };
      for (const delta of ["You plan", " the week on", " Sunday evening."]) {
        yield { type: "assistant", content: delta, uuid: "message-3" };
      }
      yield { type: "result", success: true };
    },
    close() {},
  };
  const fakeClient = {
    agents: {
      async list() {
        return [{ id: "agent-1" }];
      },
    },
    resumeSession() {
      return fakeSession;
    },
    async close() {},
  };
  const provider = new LettaMemoryProvider({ url: "http://127.0.0.1:4500" });
  Object.defineProperty(provider, "client", { value: fakeClient });

  const result = await provider.ask({
    userId: "demo-user",
    question: "When do I plan my week?",
    correlationId: "corr-test-005",
    receivedAt: "2026-09-19T08:05:00.000Z",
  });

  assert.equal(result.answer, "You plan the week on Sunday evening.");
  assert.deepEqual(result.sources, [
    { sourceId: "voice-note-009", label: "personal-context/note.md" },
  ]);
});

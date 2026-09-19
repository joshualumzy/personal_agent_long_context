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

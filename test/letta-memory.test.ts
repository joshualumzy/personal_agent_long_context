import assert from "node:assert/strict";
import { test } from "node:test";
import { LettaMemoryProvider } from "../src/adapters/letta-memory.js";

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
    ],
  });
  assert.equal(sessionOptions.length, 1);
  assert.deepEqual(
    (sessionOptions[0] as { allowedTools: string[] }).allowedTools,
    ["Read", "LS", "Glob", "Grep"],
  );
});

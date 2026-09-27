/**
 * Adversarial tests for the recruiting HTTP layer and multi-role handling.
 * Every test here asserts the CORRECT behaviour; a failing test is a bug.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { buildApp } from "../../src/http-app.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import type { GmailClient } from "../../src/recruiting/gmail.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { JsonRoleRepository, MemoryRoleRepository, RoleBoard, type RoleRepository } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { recruitingFromEnvironment } from "../../src/recruiting/config.js";

const REQUIREMENT = "We need a founding backend engineer in Singapore who knows TypeScript.";

function profile(id: string, traits: string): CandidateProfile {
  return {
    id,
    name: `Person ${id}`,
    headline: traits,
    location: "Singapore",
    profileUrl: `https://example.com/${id}`,
    workHistory: [{ title: "Engineer", company: `Company ${id}` }],
    educationHistory: [],
    summary: traits,
  };
}

const POOL = [profile("a", "typescript startup rust"), profile("b", "typescript startup")];

class FakeSource implements CandidateSource {
  readonly name = "fake";
  async search(): Promise<CandidateProfile[]> {
    return POOL;
  }
}

/** Keyword model. `gate` holds back judgements until released. */
function fakeModel(options: { gate?: Promise<void>; inputs?: unknown[] } = {}): JsonModel {
  return {
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      options.inputs?.push({ task, input });
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return {
            title: "Founding backend engineer",
            criteria: [
              { text: "typescript", kind: "must" },
              { text: "startup", kind: "must" },
            ],
            query: "typescript startup engineer singapore",
          } as T;
        case "criterion judgement":
          if (options.gate) await options.gate;
          return {
            verdicts: data.criteria.map((criterion: { id: string; text: string }) => ({
              criterionId: criterion.id,
              satisfied: data.profile.summary.includes(criterion.text) ? "yes" : "no",
              reasoning: "keyword",
            })),
          } as T;
        case "search query":
          return { queries: ["typescript startup engineer"] } as T;
        case "outreach draft":
          return { subject: `Hello ${data.candidate.name}`, body: "Hi." } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        case "reply reading":
          return {
            candidateId: data.knownCandidateId ?? data.candidates[0]?.id ?? null,
            interested: !String(data.message).includes("not interested"),
            wantsToSchedule: false,
            summary: "Replied.",
          } as T;
        default:
          return {} as T;
      }
    },
  };
}

function makeBoard(repository: RoleRepository, model: JsonModel = fakeModel(), gmail: GmailClient | null = null) {
  return new RoleBoard(
    repository,
    (store) =>
      new RecruitingService({
        model,
        source: new FakeSource(),
        store,
        memory: new LocalIntentMemory(),
        contactFinders: [],
        gmail,
        clock: () => new Date("2026-09-23T02:00:00.000Z"),
        settings: { resultsPerQuery: 6 },
      }),
  );
}

function appFor(board: RoleBoard, gmail: GmailClient | null = null) {
  return buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail } });
}

async function createRole(app: ReturnType<typeof appFor>): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/api/recruiting/roles", payload: { text: REQUIREMENT } });
  assert.equal(created.statusCode, 200, created.body);
  return created.json().roleId;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("deleted roles", () => {
  test("background scoring does not write a deleted role's file back (JSON repository)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunt-roles-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const board = makeBoard(new JsonRoleRepository(directory), fakeModel({ gate }));
    const app = appFor(board);
    const roleId = await createRole(app);
    const confirmed = await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
    assert.equal(confirmed.statusCode, 200);
    // Scoring is now waiting on the model. Delete the role.
    const removed = await app.inject({ method: "DELETE", url: `/api/recruiting/roles/${roleId}` });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(await readdir(directory), []);
    release();
    await tick();
    assert.deepEqual(await readdir(directory), [], "the deleted role's file came back");
    const listed = (await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json().roles;
    assert.equal(listed.length, 0, "the deleted role is listed again");
  });

  test("background scoring does not resurrect a deleted role (memory repository)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const board = makeBoard(new MemoryRoleRepository(), fakeModel({ gate }));
    const app = appFor(board);
    const roleId = await createRole(app);
    await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
    await app.inject({ method: "DELETE", url: `/api/recruiting/roles/${roleId}` });
    release();
    await tick();
    const state = await app.inject({ method: "GET", url: `/api/recruiting/roles/${roleId}/state` });
    assert.equal(state.statusCode, 404, "the deleted role answers again");
  });
});

describe("role listing", () => {
  test("one unreadable role file does not break the list of every role", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunt-roles-"));
    const board = makeBoard(new JsonRoleRepository(directory));
    const app = appFor(board);
    await createRole(app);
    await writeFile(join(directory, "broken.json"), "{ not json");
    const listed = await app.inject({ method: "GET", url: "/api/recruiting/roles" });
    assert.equal(listed.statusCode, 200, `list answered ${listed.statusCode}: ${listed.body}`);
    assert.equal(listed.json().roles.length, 1);
  });

  test("a role file holding valid JSON of the wrong shape does not break the list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunt-roles-"));
    const board = makeBoard(new JsonRoleRepository(directory));
    const app = appFor(board);
    await createRole(app);
    await writeFile(join(directory, "empty.json"), "{}");
    const listed = await app.inject({ method: "GET", url: "/api/recruiting/roles" });
    assert.equal(listed.statusCode, 200, `list answered ${listed.statusCode}: ${listed.body}`);
  });

  test("one unreadable role file does not stop the LinkedIn inbox for the other roles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunt-roles-"));
    const board = makeBoard(new JsonRoleRepository(directory));
    const app = appFor(board);
    await createRole(app);
    await writeFile(join(directory, "broken.json"), "{ not json");
    const read = await app.inject({
      method: "POST",
      url: "/api/recruiting/inbox/linkedin",
      payload: { threads: [{ text: "Mum: dinner?" }] },
    });
    assert.equal(read.statusCode, 200, `inbox answered ${read.statusCode}: ${read.body}`);
  });
});

describe("linkedin inbox across roles", () => {
  test("one conversation is relayed to one role, not recorded in every role that contacted the same person", async () => {
    const board = makeBoard(new MemoryRoleRepository());
    const app = appFor(board);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const roleId = await createRole(app);
      ids.push(roleId);
      await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
      await (await board.get(roleId)).settle();
      assert.equal((await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/candidates/a/outreach`, payload: {} })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/candidates/a/send`, payload: { manual: true } })).statusCode, 200);
    }
    const read = await app.inject({
      method: "POST",
      url: "/api/recruiting/inbox/linkedin",
      payload: { threads: [{ text: "Person a: sorry, not interested in the designer role." }] },
    });
    assert.equal(read.statusCode, 200);
    let recorded = 0;
    for (const roleId of ids) {
      const state = (await app.inject({ method: "GET", url: `/api/recruiting/roles/${roleId}/state` })).json();
      const a = state.candidates.find((candidate: { id: string }) => candidate.id === "a");
      recorded += a.messages.filter((message: { direction: string }) => message.direction === "inbound").length;
    }
    assert.equal(recorded, 1, `one LinkedIn message was recorded ${recorded} times across roles`);
    assert.equal(read.json().result.results.length, 1, "the same thread was processed more than once");
  });
});

describe("uploads", () => {
  test("a corrupt PDF is a client error, not an upstream failure", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()));
    const upload = await app.inject({
      method: "POST",
      url: "/api/recruiting/roles",
      payload: { filename: "jd.pdf", contentBase64: Buffer.from("this is not a pdf").toString("base64") },
    });
    assert.ok(upload.statusCode >= 400 && upload.statusCode < 500, `answered ${upload.statusCode}: ${upload.body}`);
  });

  test("a corrupt docx is a client error, not an upstream failure", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()));
    const upload = await app.inject({
      method: "POST",
      url: "/api/recruiting/roles",
      payload: { filename: "jd.docx", contentBase64: Buffer.from("this is not a docx").toString("base64") },
    });
    assert.ok(upload.statusCode >= 400 && upload.statusCode < 500, `answered ${upload.statusCode}: ${upload.body}`);
  });

  test("a file just over 5 MB is refused with 413 file_too_large", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()));
    const upload = await app.inject({
      method: "POST",
      url: "/api/recruiting/roles",
      payload: { filename: "jd.txt", contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 97).toString("base64") },
    });
    assert.equal(upload.statusCode, 413);
    assert.equal(upload.json().code, "file_too_large");
  });

  test("typed requirements are capped like uploaded ones before reaching the model", async () => {
    const inputs: Array<{ task: string; input: any }> = [];
    const app = appFor(makeBoard(new MemoryRoleRepository(), fakeModel({ inputs })));
    const huge = `${REQUIREMENT} ${"x".repeat(500_000)}`;
    const created = await app.inject({ method: "POST", url: "/api/recruiting/roles", payload: { text: huge } });
    assert.equal(created.statusCode, 200);
    const sent = JSON.stringify(inputs.find((entry) => entry.task === "criteria extraction")?.input ?? "");
    assert.ok(sent.length <= 9000, `the model received ${sent.length} characters of requirement`);
  });
});

describe("input validation", () => {
  test("a client-chosen criterion id that names an Object.prototype member is not treated as already judged", async () => {
    const board = makeBoard(new MemoryRoleRepository());
    const app = appFor(board);
    const roleId = await createRole(app);
    const revised = await app.inject({
      method: "POST",
      url: `/api/recruiting/roles/${roleId}/criteria/draft`,
      payload: { criteria: [{ id: "toString", text: "typescript", kind: "must" }] },
    });
    assert.equal(revised.statusCode, 200);
    await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
    await (await board.get(roleId)).settle();
    const state = (await app.inject({ method: "GET", url: `/api/recruiting/roles/${roleId}/state` })).json();
    const a = state.candidates.find((candidate: { id: string }) => candidate.id === "a");
    // Person a's profile says "typescript", so the only must is met.
    assert.equal(a.tier, 100, `tier was ${a.tier}; verdicts ${JSON.stringify(a.verdicts)}`);
  });

  test("control: the same criterion under an ordinary client id scores normally", async () => {
    const board = makeBoard(new MemoryRoleRepository());
    const app = appFor(board);
    const roleId = await createRole(app);
    await app.inject({
      method: "POST",
      url: `/api/recruiting/roles/${roleId}/criteria/draft`,
      payload: { criteria: [{ id: "plain1", text: "typescript", kind: "must" }] },
    });
    await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
    await (await board.get(roleId)).settle();
    const state = (await app.inject({ method: "GET", url: `/api/recruiting/roles/${roleId}/state` })).json();
    assert.equal(state.candidates.find((candidate: { id: string }) => candidate.id === "a").tier, 100);
  });

  test("a criterion whose text is not a string is refused, not stored as [object Object]", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()));
    const roleId = await createRole(app);
    const revised = await app.inject({
      method: "POST",
      url: `/api/recruiting/roles/${roleId}/criteria/draft`,
      payload: { criteria: [{ text: { nested: true }, kind: "must" }] },
    });
    const texts = revised.statusCode === 200 ? revised.json().state.criteria.map((c: { text: string }) => c.text) : [];
    assert.ok(!texts.includes("[object Object]"), `stored criteria ${JSON.stringify(texts)}`);
  });

  test("fast-forward refuses a non-number days value", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()));
    const roleId = await createRole(app);
    for (const days of [true, [5], "3"]) {
      const moved = await app.inject({
        method: "POST",
        url: `/api/recruiting/roles/${roleId}/fast-forward`,
        payload: { days },
      });
      assert.equal(moved.statusCode, 400, `days=${JSON.stringify(days)} answered ${moved.statusCode}`);
    }
  });
});

describe("non-bugs (expected to pass)", () => {
  test("a failed create leaves no role file behind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunt-roles-"));
    const model: JsonModel = { async json() { throw new Error("model down"); } };
    const app = appFor(makeBoard(new JsonRoleRepository(directory), model));
    const created = await app.inject({ method: "POST", url: "/api/recruiting/roles", payload: { text: REQUIREMENT } });
    assert.equal(created.statusCode, 502);
    const short = await app.inject({ method: "POST", url: "/api/recruiting/roles", payload: { text: "hi" } });
    assert.equal(short.statusCode, 400);
    assert.deepEqual(await readdir(directory).catch(() => []), []);
  });

  test("gmail inbox copes with an unconfirmed role", async () => {
    const gmail = { connected: async () => true, hasMailbox: async () => true, repliesFrom: async () => [] } as unknown as GmailClient;
    const board = makeBoard(new MemoryRoleRepository(), fakeModel(), gmail);
    const app = appFor(board, gmail);
    await createRole(app);
    const read = await app.inject({ method: "POST", url: "/api/recruiting/inbox/gmail" });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().result.read, 0);
  });

  test("ids that could reach the filesystem are 404 on every per-role route and delete", async () => {
    const app = appFor(makeBoard(new JsonRoleRepository(await mkdtemp(join(tmpdir(), "hunt-roles-")))));
    for (const id of ["..%2F..%2Fetc", "ABC", "%C3%A9", "a.json", "x".repeat(41)]) {
      assert.equal((await app.inject({ method: "GET", url: `/api/recruiting/roles/${id}/state` })).statusCode, 404, id);
      assert.equal((await app.inject({ method: "DELETE", url: `/api/recruiting/roles/${id}` })).statusCode, 404, id);
      assert.equal((await app.inject({ method: "POST", url: `/api/recruiting/roles/${id}/say`, payload: { text: "x" } })).statusCode, 404, id);
    }
  });

  test("the linkedin inbox with no roles and with a role that contacted nobody", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()));
    const empty = await app.inject({ method: "POST", url: "/api/recruiting/inbox/linkedin", payload: { threads: [{ text: "hello" }, 5, null] } });
    assert.equal(empty.statusCode, 200);
    await createRole(app);
    const one = await app.inject({ method: "POST", url: "/api/recruiting/inbox/linkedin", payload: { threads: [{ text: "hello" }] } });
    assert.deepEqual(one.json().result, { read: 1, ignored: 1, results: [] });
    assert.equal((await app.inject({ method: "POST", url: "/api/recruiting/inbox/linkedin", payload: { threads: {} } })).statusCode, 400);
  });
});

describe("gmail oauth", () => {
  function fakeGmail(exchange: () => Promise<void>): GmailClient {
    return {
      consentUrl: (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      exchangeCode: exchange,
      connected: async () => false,
      storedAddress: async () => null,
    } as unknown as GmailClient;
  }

  test("a state value is single use", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()), fakeGmail(async () => {}));
    const connect = await app.inject({ method: "GET", url: "/api/recruiting/gmail/connect" });
    const state = new URL(String(connect.headers.location)).searchParams.get("state");
    const first = await app.inject({ method: "GET", url: `/api/recruiting/gmail/callback?code=x&state=${state}` });
    assert.equal(first.statusCode, 302);
    const second = await app.inject({ method: "GET", url: `/api/recruiting/gmail/callback?code=x&state=${state}` });
    assert.equal(second.statusCode, 400);
  });

  test("a failed code exchange is reported as an upstream failure, not an unhandled 500", async () => {
    const app = appFor(
      makeBoard(new MemoryRoleRepository()),
      fakeGmail(async () => {
        throw new Error("Google did not return a refresh token.");
      }),
    );
    const connect = await app.inject({ method: "GET", url: "/api/recruiting/gmail/connect" });
    const state = new URL(String(connect.headers.location)).searchParams.get("state");
    const callback = await app.inject({ method: "GET", url: `/api/recruiting/gmail/callback?code=x&state=${state}` });
    assert.notEqual(callback.statusCode, 500, callback.body);
  });
});

describe("pages and headers", () => {
  test("only /recruiting is frameable; its assets and every other page deny framing", async () => {
    const app = appFor(makeBoard(new MemoryRoleRepository()));
    const page = await app.inject({ method: "GET", url: "/recruiting" });
    assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");
    assert.match(String(page.headers["content-type"]), /text\/html/);
    for (const url of ["/", "/recruiting/app.js", "/recruiting/styles.css"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.headers["x-frame-options"], "DENY", url);
      assert.match(String(response.headers["content-security-policy"]), /frame-ancestors 'none'/, url);
    }
    assert.match(String((await app.inject({ method: "GET", url: "/recruiting/app.js" })).headers["content-type"]), /javascript/);
    assert.match(String((await app.inject({ method: "GET", url: "/recruiting/styles.css" })).headers["content-type"]), /text\/css/);
    const slash = await app.inject({ method: "GET", url: "/recruiting/" });
    assert.equal(slash.statusCode, 301);
    assert.equal(slash.headers.location, "/recruiting");
  });
});

describe("configuration", () => {
  const base = { SOCLAAS_BASE_URL: "http://127.0.0.1:1", SOCLAAS_API_KEY: "k", MEMORY_ADAPTER: "deterministic" };
  const noop = () => {};

  test("an empty RECRUITING_RESULTS_PER_QUERY (KEY= in .env) is treated as unset like every other key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunt-config-"));
    assert.doesNotThrow(() =>
      recruitingFromEnvironment(
        {
          ...base,
          RECRUITING_RESULTS_PER_QUERY: "",
          RECRUITING_ROLES_DIR: join(directory, "roles"),
          RECRUITING_STATE_PATH: join(directory, "none.json"),
        },
        new DeterministicMemoryProvider(),
        noop,
      ),
    );
  });

  test("RECRUITING_RESULTS_PER_QUERY rejects zero, negatives and decimals", async () => {
    for (const value of ["0", "-1", "2.5", "abc"]) {
      assert.throws(
        () => recruitingFromEnvironment({ ...base, RECRUITING_RESULTS_PER_QUERY: value }, new DeterministicMemoryProvider(), noop),
        /positive integer/,
        value,
      );
    }
  });
});

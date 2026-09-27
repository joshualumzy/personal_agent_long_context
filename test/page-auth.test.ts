import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import type { MeetingActions } from "../src/meetings/domain.js";
import { MemoryRoleRepository, RoleBoard } from "../src/recruiting/roles.js";

// With sign-in required, the meetings and recruiting pages and their data are
// for signed-in employees only; anyone else is sent to sign in and brought back.

const meetings = { list: async () => [], get: async () => null, subscribe: () => () => {} } as unknown as MeetingActions;
const board = new RoleBoard(new MemoryRoleRepository(), (() => {
  throw new Error("not used");
}) as never);

function signedInApp() {
  const app = buildApp({
    memory: new DeterministicMemoryProvider(),
    sessionConfig: { secret: "page-auth-test-secret-that-is-at-least-32-chars" },
    meetings: { service: meetings },
    recruiting: { board, gmail: null },
  });
  after(() => app.close());
  return app;
}

async function cookieFor(app: ReturnType<typeof buildApp>) {
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { employeeId: "jax", password: "password" } });
  const cookie = login.headers["set-cookie"];
  return (Array.isArray(cookie) ? cookie[0]! : String(cookie)).split(";")[0]!;
}

describe("Signing in for meetings and recruiting", () => {
  test("sends a signed-out visitor to sign in, remembering where they were going", async () => {
    const app = signedInApp();
    for (const url of ["/meetings", "/meetings/m1", "/recruiting"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 302, url);
      assert.equal(response.headers.location, `/?next=${encodeURIComponent(url)}`);
    }
  });

  test("keeps meeting and recruiting data from signed-out requests", async () => {
    const app = signedInApp();
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/meetings" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/recruiting/roles" })).statusCode, 401);
  });

  test("serves the pages and their data once signed in", async () => {
    const app = signedInApp();
    const cookie = await cookieFor(app);
    assert.equal((await app.inject({ method: "GET", url: "/meetings", headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/meetings/m1", headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/recruiting", headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/meetings", headers: { cookie } })).statusCode, 200);
  });

  test("still serves the page's own script and styles, which hold no data", async () => {
    const app = signedInApp();
    assert.equal((await app.inject({ method: "GET", url: "/meetings/app.js" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/theme.css" })).statusCode, 200);
  });
});

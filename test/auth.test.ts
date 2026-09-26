import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from "../src/auth.js";

const TEST_SECRET = "test-auth-session-secret-key-32chars-min";

describe("Authentication & Session Management", () => {
  test("hashes and verifies passwords securely", () => {
    const hash = hashPassword("password");
    assert.ok(hash);
    assert.equal(verifyPassword("password", hash), true);
    assert.equal(verifyPassword("wrong-password", hash), false);
  });

  test("creates and verifies cryptographic session tokens", () => {
    const token = createSessionToken("priya", TEST_SECRET);
    assert.ok(token);

    const verified = verifySessionToken(token, TEST_SECRET);
    assert.ok(verified);
    assert.equal(verified.employeeId, "priya");

    // Tampered token fails verification
    const tampered = token.slice(0, -5) + "abcde";
    assert.equal(verifySessionToken(tampered, TEST_SECRET), null);

    // Garbage token fails verification
    assert.equal(verifySessionToken("invalid.token.here", TEST_SECRET), null);
  });

  test("HTTP auth endpoints: login, session validation, me, and logout", async () => {
    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      sessionConfig: { secret: TEST_SECRET },
    });

    // 1. GET /api/v1/auth/personas
    const personasRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/personas",
    });
    assert.equal(personasRes.statusCode, 200);
    const personas = personasRes.json();
    assert.equal(Array.isArray(personas), true);
    assert.ok(personas.length >= 5);
    const jax = personas.find((p: { employeeId: string }) => p.employeeId === "jax");
    const priya = personas.find((p: { employeeId: string }) => p.employeeId === "priya");
    assert.ok(jax);
    assert.ok(priya);
    assert.equal(priya.role, "Product Designer");

    // 2. Reject invalid password
    const failRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { employeeId: "priya", password: "incorrect-password" },
    });
    assert.equal(failRes.statusCode, 401);

    // 3. Successful login returns ok, employee, sets cookie, but NO raw token in JSON body
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { employeeId: "priya", password: "password" },
    });
    assert.equal(loginRes.statusCode, 200);
    const loginData = loginRes.json();
    assert.equal(loginData.ok, true);
    assert.equal(loginData.employee.employeeId, "priya");
    assert.equal(loginData.token, undefined);
    const setCookie = loginRes.headers["set-cookie"];
    assert.ok(setCookie);
    assert.match(String(setCookie), /sme_session=/);
    assert.match(String(setCookie), /HttpOnly/i);

    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    const cookieToken = cookieHeader.split(";")[0].replace("sme_session=", "");

    // 4. GET /api/v1/auth/me with Cookie
    const meCookieRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieHeader },
    });
    assert.equal(meCookieRes.statusCode, 200);
    const meData = meCookieRes.json();
    assert.equal(meData.authenticated, true);
    assert.equal(meData.employee.employeeId, "priya");

    // 5. GET /api/v1/auth/me with Bearer token
    const meBearerRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${cookieToken}` },
    });
    assert.equal(meBearerRes.statusCode, 200);
    assert.equal(meBearerRes.json().employee.employeeId, "priya");

    // 6. Unauthenticated /me returns 401
    const unauthRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
    });
    assert.equal(unauthRes.statusCode, 401);

    // 7. Logout clears session cookie
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
    });
    assert.equal(logoutRes.statusCode, 200);
    assert.match(String(logoutRes.headers["set-cookie"]), /Max-Age=0/);

    await app.close();
  });
});

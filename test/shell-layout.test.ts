import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import type { MeetingActions } from "../src/meetings/domain.js";
import { MemoryRoleRepository, RoleBoard } from "../src/recruiting/roles.js";

// Moving between pages must not move the frame: the same pieces sit at the
// same pixels. jsdom has no layout, so this measures in a real browser.
// Kaki's one entry (the assistant and meetings) has a top bar and no sidebar;
// the pages not yet brought into it (recruiting, the emergent graph) keep the
// older sidebar, the same on each. /graph opens inside the chat's dialog.
const TOPBAR_PAGES = ["/", "/meetings"];
const PAGES = ["/recruiting", "/graph/emergent"];

const MEASURE_TOP = `(() => {
  const rect = (element) => {
    if (!element) return null;
    const { left, top, width, height } = element.getBoundingClientRect();
    return [left, top, width, height].map(Math.round);
  };
  return {
    plate: rect(document.querySelector("#plate")),
    brand: rect(document.querySelector("#plate .brand")),
    avatar: rect(document.querySelector("#plate .shell-user .shell-avatar")),
    brandFont: document.querySelector("#plate .brand") ? getComputedStyle(document.querySelector("#plate .brand")).fontFamily : null,
    sidebar: rect(document.querySelector(".shell-side")),
  };
})()`;

const MEASURE = `(() => {
  const rect = (element) => {
    if (!element) return null;
    const { left, top, width, height } = element.getBoundingClientRect();
    return [left, top, width, height].map(Math.round);
  };
  return {
    sidebar: rect(document.querySelector(".shell-side")),
    // The name's box is narrower where a collapse button shares its row, so compare where it starts.
    logo: rect(document.querySelector(".shell-side .workspace .logo")),
    links: [...document.querySelectorAll(".shell-side .app-nav a")].map(rect),
    mainLeft: rect(document.querySelector(".shell-main"))?.[0],
    user: rect(document.querySelector(".shell-side .shell-user")),
    avatar: rect(document.querySelector(".shell-side .shell-user .shell-avatar")),
    navFont: getComputedStyle(document.querySelector(".app-nav a")).fontFamily,
  };
})()`;

type Box = [number, number, number, number];
interface Layout {
  sidebar: Box | null;
  logo: Box | null;
  links: Box[];
  mainLeft: number | undefined;
  user: Box | null;
  avatar: Box | null;
  navFont: string;
}

const meetings = {
  list: async () => [],
  get: async () => null,
  subscribe: () => () => {},
} as unknown as MeetingActions;
const board = new RoleBoard(new MemoryRoleRepository(), (() => {
  throw new Error("not used");
}) as never);

describe("Shared shell layout", () => {
  let browser: Browser;
  let base: string;
  const app = buildApp({ memory: new DeterministicMemoryProvider(), meetings: { service: meetings }, recruiting: { board, gmail: null } });

  before(async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app.close();
  });

  async function measureTop(path: string) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
    await page.goto(`${base}${path}`);
    await page.evaluate(() => document.fonts.ready);
    const boxes = await page.evaluate<Record<string, unknown>>(MEASURE_TOP);
    await page.close();
    return boxes;
  }

  test("the assistant page has the plate on the left, with the Kaki mark and the employee", async () => {
    const home = await measureTop("/");
    assert.ok(home.plate, "the plate");
    assert.ok(home.brand, "the Kaki mark");
    assert.ok(home.avatar, "the signed-in employee");
    assert.equal(home.sidebar, null, "and not the old sidebar");
  });

  test("puts the plate, the Kaki mark and the employee at the same pixels on the assistant and meetings", { todo: "the meetings page moves onto the plate next" }, async () => {
    const [first, ...rest] = await Promise.all(TOPBAR_PAGES.map(measureTop));
    assert.ok(first!.plate, "the assistant page has the plate");
    assert.equal(first!.sidebar, null, "and no sidebar");
    rest.forEach((other, index) => {
      assert.deepEqual(other, first, `${TOPBAR_PAGES[index + 1]} differs from /`);
    });
  });

  async function measure(path: string) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
    await page.goto(`${base}${path}`);
    await page.evaluate(() => document.fonts.ready);
    // A string, not a function: tsx rewrites functions with helpers the page does not have.
    const boxes = await page.evaluate<Layout>(MEASURE);
    await page.close();
    return boxes;
  }

  test("the pages that keep the sidebar put it at the same pixels", async () => {
    const [first, ...rest] = await Promise.all(PAGES.map(measure));
    assert.ok(first!.sidebar, "the recruiting page has the shared sidebar");
    assert.equal(first!.links.length, 3);
    assert.ok(first!.user, "the signed-in person sits at the foot of the sidebar");
    rest.forEach((other, index) => {
      assert.deepEqual(other, first, `${PAGES[index + 1]} differs from ${PAGES[0]}`);
    });
  });

  test("draws icons as line icons, never as emoji or check-mark characters", async () => {
    const assets = [
      "/", "/app.js", "/meetings", "/meetings/app.js", "/recruiting", "/recruiting/app.js",
      "/graph", "/graph/app.js", "/graph/emergent", "/graph/emergent.js",
    ];
    const iconLike = /[\p{Extended_Pictographic}\u2713\u2715\u2717]/u;
    for (const url of assets) {
      const body = (await app.inject({ method: "GET", url })).body;
      const hit = body.split("\n").find((line) => iconLike.test(line));
      assert.equal(hit, undefined, `${url} draws an icon with a character: ${hit?.trim()}`);
    }
  });

  test("the company graph pages use the shared theme; the emergent one sits in the shell", async () => {
    for (const url of ["/graph", "/graph/emergent"]) {
      const html = (await app.inject({ method: "GET", url })).body;
      assert.match(html, /<link rel="stylesheet" href="\/theme.css">/, url);
    }
    const emergent = (await app.inject({ method: "GET", url: "/graph/emergent" })).body;
    assert.match(emergent, /<a href="\/graph" aria-current="page">/);
  });
});

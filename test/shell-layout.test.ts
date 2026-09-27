import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import type { MeetingActions } from "../src/meetings/domain.js";
import { MemoryRoleRepository, RoleBoard } from "../src/recruiting/roles.js";

// Switching between the three apps must not move the sidebar: the same
// pieces sit at the same pixels on every page. jsdom has no layout, so this
// measures in a real browser.
const PAGES = ["/", "/meetings", "/recruiting"];

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

  async function measure(path: string) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
    await page.goto(`${base}${path}`);
    await page.evaluate(() => document.fonts.ready);
    // A string, not a function: tsx rewrites functions with helpers the page does not have.
    const boxes = await page.evaluate<Layout>(MEASURE);
    await page.close();
    return boxes;
  }

  test("puts the sidebar, the workspace name and the app links at the same pixels on every page", async () => {
    const [first, ...rest] = await Promise.all(PAGES.map(measure));
    assert.ok(first!.sidebar, "the assistant page has the shared sidebar");
    assert.equal(first!.links.length, 2);
    assert.ok(first!.user, "the signed-in person sits at the foot of the sidebar");
    rest.forEach((other, index) => {
      assert.deepEqual(other, first, `${PAGES[index + 1]} differs from /`);
    });
  });

  test("draws icons as line icons, never as emoji or check-mark characters", async () => {
    const assets = ["/", "/app.js", "/meetings", "/meetings/app.js", "/recruiting", "/recruiting/app.js"];
    const iconLike = /[\p{Extended_Pictographic}\u2713\u2715\u2717]/u;
    for (const url of assets) {
      const body = (await app.inject({ method: "GET", url })).body;
      const hit = body.split("\n").find((line) => iconLike.test(line));
      assert.equal(hit, undefined, `${url} draws an icon with a character: ${hit?.trim()}`);
    }
  });
});

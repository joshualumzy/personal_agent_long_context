/**
 * Reads the founder's recent LinkedIn conversations and hands any new text to
 * the recruiting agent, which decides which candidate each one is from.
 *
 * Read only: this script opens threads and copies their text. It never types
 * into the message box, never clicks send, and never visits a profile.
 * LinkedIn's terms forbid automated access, so it runs rarely, on demand, in
 * the founder's own logged-in browser profile, and pasting a reply into the
 * app remains the supported path.
 *
 *   npm run linkedin:login    # once: opens a window, log in by hand
 *   npm run linkedin:sync     # reads the latest threads and posts new text
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const PROFILE_DIR = process.env.LINKEDIN_PROFILE_DIR ?? "data/linkedin-profile";
const SEEN_PATH = process.env.LINKEDIN_SEEN_PATH ?? "data/linkedin-seen.json";
const APP_URL = process.env.RECRUITING_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const THREADS = Number(process.env.LINKEDIN_THREADS ?? "10");
const login = process.argv.includes("--login");

async function loadSeen(): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await readFile(SEEN_PATH, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

await mkdir(PROFILE_DIR, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: !login,
  viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded" });

  if (/\/(login|checkpoint|authwall)/.test(page.url())) {
    if (!login) {
      console.error("Not logged in. Run `npm run linkedin:login` once and log in by hand.");
      process.exitCode = 1;
    } else {
      console.log("Log in to LinkedIn in the window that opened. Waiting up to 5 minutes…");
      await page.waitForURL(/linkedin\.com\/(feed|messaging)/, { timeout: 5 * 60_000 });
      console.log("Logged in. The session is saved; `npm run linkedin:sync` can now run headless.");
    }
  } else if (login) {
    console.log("Already logged in.");
  } else {
    await page.waitForSelector('a[href*="/messaging/thread/"]', { timeout: 30_000 });
    const links = await page.$$eval('a[href*="/messaging/thread/"]', (anchors) => [
      ...new Set(anchors.map((anchor) => (anchor as HTMLAnchorElement).href.split("?")[0]!)),
    ]);

    const seen = await loadSeen();
    const fresh: { text: string }[] = [];
    for (const link of links.slice(0, THREADS)) {
      await page.goto(link, { waitUntil: "domcontentloaded" });
      // Take the whole conversation pane as text rather than parsing each
      // message, so a markup change does not break the reader; the model reads it.
      const text = await page
        .locator(".msg-s-message-list, [class*='message-list'], main")
        .first()
        .innerText({ timeout: 15_000 })
        .catch(() => "");
      const trimmed = text.replace(/\n{3,}/g, "\n\n").trim().slice(-4000);
      if (!trimmed) continue;
      const id = fingerprint(trimmed);
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push({ text: trimmed });
      await page.waitForTimeout(1500 + Math.random() * 1500);
    }

    if (fresh.length === 0) {
      console.log("No new LinkedIn messages.");
    } else {
      const response = await fetch(`${APP_URL}/api/recruiting/inbox/linkedin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threads: fresh }),
      });
      const body = (await response.json()) as { result?: { results?: { message: string }[] }; message?: string };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      for (const result of body.result?.results ?? []) console.log(`- ${result.message}`);
      await writeFile(SEEN_PATH, JSON.stringify([...seen]));
    }
  }
} finally {
  await context.close();
}

/**
 * Reads the founder's recent LinkedIn conversations and hands any new text to
 * the recruiting agent, which decides which candidate each one is from.
 *
 * Read only: it loads the inbox and copies the preview of each conversation
 * (who, and their latest message). It clicks nothing, so it cannot send a
 * message or even mark one as read, and it never visits a profile.
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

/** A preview's time label ("10:32 AM", "Tue") changes as the day passes; the message does not. */
const TIME_LABEL =
  /^(\d{1,2}:\d{2}(\s*[ap]m)?|now|yesterday|today|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[a-z]{3} \d{1,2}(, \d{4})?|\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d+[mhdw])$/i;

function fingerprint(text: string): string {
  const message = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !TIME_LABEL.test(line))
    .join("\n");
  return createHash("sha256").update(message).digest("hex");
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
    const items = page.locator(".msg-conversation-listitem");
    await items.first().waitFor({ timeout: 30_000 });
    const previews = (await items.allInnerTexts()).slice(0, THREADS);

    const seen = await loadSeen();
    const fresh: { text: string }[] = [];
    for (const preview of previews) {
      const text = preview.replace(/\n{2,}/g, "\n").trim();
      // A preview whose latest line is the founder's own message holds no reply.
      if (!text || /(^|\n)You:/.test(text)) continue;
      const id = fingerprint(text);
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push({ text });
    }

    if (fresh.length === 0) {
      console.log("No new LinkedIn messages.");
    } else {
      const response = await fetch(`${APP_URL}/api/recruiting/inbox/linkedin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threads: fresh }),
      });
      const body = (await response.json()) as {
        result?: { ignored?: number; results?: { message: string }[]; failed?: string[] };
        message?: string;
      };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      console.log(
        `Read ${fresh.length} conversations; ${body.result?.ignored ?? 0} did not mention anyone you contacted and were ignored.`,
      );
      for (const result of body.result?.results ?? []) console.log(`- ${result.message}`);
      // A conversation the app could not read is tried again next time.
      for (const text of body.result?.failed ?? []) seen.delete(fingerprint(text));
      await writeFile(SEEN_PATH, JSON.stringify([...seen]));
    }
  }
} finally {
  await context.close();
}

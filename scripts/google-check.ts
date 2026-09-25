/**
 * Checks the stored Google grant used by Recruiting (Gmail) and Meeting
 * actions (Gmail contacts, calendar free/busy): which mailbox it is, which
 * scopes it carries, and whether free/busy answers. Prints no token.
 *
 *   npm run google:check
 */
import { readFile } from "node:fs/promises";

const FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy";
const tokenPath = process.env.GMAIL_TOKEN_PATH ?? "data/gmail-token.json";
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const port = process.env.PORT ?? "3000";

function done(message: string, code = 0): never {
  console.log(message);
  process.exit(code);
}

if (!clientId || !clientSecret) done("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in .env.", 1);

let refreshToken: string;
try {
  refreshToken = (JSON.parse(await readFile(tokenPath, "utf8")) as { refresh_token: string }).refresh_token;
} catch {
  done(`Not connected: no ${tokenPath}. Start the app and open http://127.0.0.1:${port}/api/recruiting/gmail/connect`, 1);
}

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
});
const token = (await tokenResponse.json()) as { access_token?: string; scope?: string; error?: string };
if (!tokenResponse.ok || !token.access_token) {
  done(
    `The stored grant no longer works (${token.error ?? tokenResponse.status}). Grants from an app in testing mode expire after 7 days. Reconnect: http://127.0.0.1:${port}/api/recruiting/gmail/connect`,
    1,
  );
}

const auth = { authorization: `Bearer ${token.access_token}` };
const profile = (await (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth })).json()) as { emailAddress?: string };
const scopes = (token.scope ?? "").split(" ");
console.log(
  profile.emailAddress
    ? `Mailbox: ${profile.emailAddress}`
    : "Mailbox: NONE. This Google account has no Gmail, so sending and reading replies fail. Reconnect with the account you use for email.",
);
for (const scope of scopes) console.log(`  granted: ${scope.replace("https://www.googleapis.com/auth/", "")}`);

if (!scopes.includes(FREEBUSY)) {
  done(`Calendar free/busy: NOT granted. Reconnect to add it: http://127.0.0.1:${port}/api/recruiting/gmail/connect`, 1);
}

const now = new Date();
const busyResponse = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 7 * 86_400_000).toISOString(), items: [{ id: "primary" }] }),
});
const busy = (await busyResponse.json()) as {
  calendars?: { primary?: { busy?: unknown[] } };
  error?: { message?: string; errors?: Array<{ reason?: string }> };
};
if (!busyResponse.ok) {
  const reason = busy.error?.errors?.[0]?.reason ?? "";
  const hint =
    reason === "accessNotConfigured" || /has not been used|is disabled/i.test(busy.error?.message ?? "")
      ? " Enable the Google Calendar API in the Google Cloud project that owns this OAuth client, wait a minute, and run this again."
      : "";
  done(`Calendar free/busy: FAILED (HTTP ${busyResponse.status} ${reason}).${hint}`, 1);
}
done(`Calendar free/busy: OK, ${busy.calendars?.primary?.busy?.length ?? 0} busy period(s) in the next 7 days.`);

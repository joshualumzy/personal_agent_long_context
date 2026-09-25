import { readFile, writeFile } from "node:fs/promises";

/**
 * Reads, never sends: replies in the founder's own Gmail, names and addresses
 * in message headers, and when they are busy. Outreach is written here but
 * sent by the founder from their own mailbox. The OAuth app stays in Google's
 * testing mode with the team as test users, so no review is needed. Two
 * scopes: Gmail read-only, and calendar free/busy, which shows when someone
 * is busy but never what the event is.
 */
const CALENDAR_FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", CALENDAR_FREEBUSY];

export interface BusyPeriod {
  start: string;
  end: string;
}

export interface GmailOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
  fetch?: typeof fetch;
}

export interface InboundMessage {
  from: string;
  at: string;
  text: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function plainText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = plainText(child);
    if (found) return found;
  }
  return "";
}

/** Drops the quoted history below a reply so only the new text remains. */
function withoutQuote(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex(
    (line) => /^On .+wrote:$/.test(line.trim()) || /^>/.test(line) || /^-{2,}\s*Original Message/i.test(line),
  );
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}

export interface GmailContact {
  name: string;
  email: string;
  /** How many header entries named this address. */
  count: number;
}

const ADDRESS_RE = /(?:"?([^"<>,;]*?)"?\s*)<([^<>\s@]+@[^<>\s]+)>|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

/**
 * Addresses in raw From/To/Cc header values whose display name contains every
 * word of `name`, or whose local part starts with its first word, most
 * frequent first. `own` (the mailbox owner) is never returned.
 */
export function contactsMatching(headerValues: string[], name: string, own: string): GmailContact[] {
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const found = new Map<string, GmailContact>();
  for (const value of headerValues) {
    for (const match of value.matchAll(ADDRESS_RE)) {
      const email = (match[2] ?? match[3] ?? "").toLowerCase();
      const display = (match[1] ?? "").trim();
      if (!email || email === own) continue;
      const lowerDisplay = display.toLowerCase();
      const byName = display !== "" && words.every((word) => lowerDisplay.includes(word));
      const byAddress = words[0]!.length >= 3 && email.split("@")[0]!.startsWith(words[0]!);
      if (!byName && !byAddress) continue;
      const entry = found.get(email) ?? { name: display, email, count: 0 };
      if (!entry.name && display) entry.name = display;
      entry.count += 1;
      found.set(email, entry);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

/** The Google account that consented has no Gmail mailbox. */
export class NoGmailError extends Error {
  constructor() {
    super("That Google account has no Gmail mailbox.");
  }
}

export class GmailClient {
  private readonly fetch: typeof fetch;
  private accessToken: { value: string; expiresAt: number } | null = null;
  private ownAddress: string | null = null;
  private grantedScopes: Set<string> | null = null;

  constructor(private readonly options: GmailOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  consentUrl(state: string, loginHint?: string): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    // Preselect the account connected last time, so a reconnect does not
    // land on a different Google account by accident.
    if (loginHint) params.set("login_hint", loginHint);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async connected(): Promise<boolean> {
    return (await this.refreshToken()) !== null;
  }

  /**
   * Stores a new grant only when its account actually has Gmail. A Google
   * account without Gmail (one made from another email address) would
   * otherwise replace a working grant and break sending, so it is refused and
   * the previous grant is kept.
   */
  async exchangeCode(code: string): Promise<void> {
    const token = await this.tokenRequest({
      code,
      grant_type: "authorization_code",
      redirect_uri: this.options.redirectUri,
    });
    if (!token.refresh_token) throw new Error("Google did not return a refresh token.");
    const profile = await this.fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!profile.ok) throw new NoGmailError();
    const { emailAddress } = (await profile.json()) as { emailAddress: string };
    await writeFile(
      this.options.tokenPath,
      JSON.stringify({ refresh_token: token.refresh_token, email: emailAddress }),
      { mode: 0o600 },
    );
    this.ownAddress = emailAddress;
    this.remember(token);
  }

  /**
   * True only when the connected account has a Gmail mailbox. A grant from a
   * Google account without Gmail is "connected" yet cannot read mail, and the
   * pages must ask for a different account rather than report it as working.
   */
  async hasMailbox(): Promise<boolean> {
    if (!(await this.connected())) return false;
    try {
      await this.address();
      return true;
    } catch {
      return false;
    }
  }

  async address(): Promise<string> {
    if (this.ownAddress) return this.ownAddress;
    const profile = (await this.api("users/me/profile")) as { emailAddress: string };
    this.ownAddress = profile.emailAddress;
    return profile.emailAddress;
  }

  /**
   * Messages from `address` received after `since`, as plain text without the
   * quoted history. Outreach is sent by the founder from their own mailbox,
   * so replies are found by who sent them rather than by thread.
   */
  async repliesFrom(address: string, since: string): Promise<InboundMessage[]> {
    const sinceMs = Date.parse(since);
    const after = Math.floor(sinceMs / 1000);
    const query = encodeURIComponent(`from:${address} after:${after}`);
    const list = (await this.api(`users/me/messages?q=${query}&maxResults=10`)) as { messages?: { id: string }[] };
    const replies: InboundMessage[] = [];
    for (const { id } of list.messages ?? []) {
      const message = (await this.api(`users/me/messages/${id}?format=full`)) as {
        internalDate?: string;
        payload?: GmailPart & { headers?: { name: string; value: string }[] };
      };
      const from = message.payload?.headers?.find((header) => header.name.toLowerCase() === "from")?.value ?? "";
      const at = new Date(Number(message.internalDate ?? 0)).toISOString();
      const text = withoutQuote(plainText(message.payload));
      if (Date.parse(at) > sinceMs && text.length > 0) replies.push({ from, at, text });
    }
    return replies.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  /**
   * People whose name matches `name`, taken from the From/To/Cc headers of
   * recent messages that mention it. Only header metadata is fetched; message
   * bodies are never read. Uses the existing read-only scope.
   */
  async contactsNamed(name: string, limit = 3): Promise<GmailContact[]> {
    const own = (await this.address()).toLowerCase();
    const query = encodeURIComponent(`"${name.replace(/"/g, "")}"`);
    const list = (await this.api(`users/me/messages?q=${query}&maxResults=10`)) as { messages?: { id: string }[] };
    const headerValues: string[] = [];
    for (const { id } of list.messages ?? []) {
      const message = (await this.api(
        `users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
      )) as { payload?: { headers?: { name: string; value: string }[] } };
      for (const header of message.payload?.headers ?? []) headerValues.push(header.value);
    }
    return contactsMatching(headerValues, name, own).slice(0, limit);
  }

  /** False when the stored grant predates the free/busy scope: reconnect to add it. */
  async canReadCalendar(): Promise<boolean> {
    if (!(await this.connected())) return false;
    try {
      await this.bearer();
    } catch {
      return false;
    }
    return this.grantedScopes?.has(CALENDAR_FREEBUSY) ?? false;
  }

  /**
   * Busy periods between `from` and `to` for each calendar: "primary" is the
   * mailbox owner's own. A calendar the owner cannot see (most people outside
   * their Google Workspace) comes back as null, meaning unknown, not free.
   */
  async busy(calendars: string[], from: string, to: string): Promise<Map<string, BusyPeriod[] | null>> {
    const response = await this.fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { authorization: `Bearer ${await this.bearer()}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: from, timeMax: to, items: calendars.map((id) => ({ id })) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Calendar free/busy request failed with HTTP ${response.status}.`);
    const body = (await response.json()) as {
      calendars?: Record<string, { busy?: BusyPeriod[]; errors?: unknown[] }>;
    };
    const result = new Map<string, BusyPeriod[] | null>();
    for (const id of calendars) {
      const entry = body.calendars?.[id];
      result.set(id, !entry || (entry.errors && entry.errors.length > 0) ? null : entry.busy ?? []);
    }
    return result;
  }

  /** The mailbox connected last time, from the stored grant, if known. */
  async storedAddress(): Promise<string | null> {
    try {
      const stored = JSON.parse(await readFile(this.options.tokenPath, "utf8")) as { email?: string };
      return stored.email ?? null;
    } catch {
      return null;
    }
  }

  private async refreshToken(): Promise<string | null> {
    try {
      const stored = JSON.parse(await readFile(this.options.tokenPath, "utf8")) as {
        refresh_token?: string;
      };
      return stored.refresh_token ?? null;
    } catch {
      return null;
    }
  }

  private remember(token: { access_token: string; expires_in: number; scope?: string }) {
    this.accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + (token.expires_in - 60) * 1000,
    };
    if (token.scope) this.grantedScopes = new Set(token.scope.split(" "));
  }

  private async tokenRequest(fields: Record<string, string>) {
    const response = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        ...fields,
      }),
    });
    if (!response.ok) throw new Error(`Google token request failed with HTTP ${response.status}.`);
    return (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope?: string;
    };
  }

  private async bearer(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.value;
    }
    const refresh = await this.refreshToken();
    if (!refresh) throw new Error("Gmail is not connected.");
    const token = await this.tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
    this.remember(token);
    return token.access_token;
  }

  private async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(`https://gmail.googleapis.com/gmail/v1/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.bearer()}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Gmail request failed with HTTP ${response.status}.`);
    return response.json();
  }
}

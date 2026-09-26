import { readFile, writeFile } from "node:fs/promises";

/**
 * Sends from, and reads replies in, the founder's own Gmail. The OAuth app
 * stays in Google's testing mode with the team as test users, so no review is
 * needed. Only two scopes: send, and read-only to see replies.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

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

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function partText(part: GmailPart | undefined, mimeType: string): string {
  if (!part) return "";
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = partText(child, mimeType);
    if (found) return found;
  }
  return "";
}

/** The plain-text body, or the HTML one as text when the reply was sent as HTML only. */
function plainText(part: GmailPart | undefined): string {
  const plain = partText(part, "text/plain");
  if (plain) return plain;
  const html = partText(part, "text/html");
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<blockquote[\s\S]*$/i, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The bare address in a From header: "Jax Tan <jax@x.com>" is "jax@x.com". */
function addressOf(from: string): string {
  const bracketed = /<([^>]+)>/.exec(from);
  return (bracketed ? bracketed[1]! : from).trim().toLowerCase();
}

/** Drops the quoted history below a reply so only the new text remains. */
function withoutQuote(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex(
    (line, index) =>
      /^On .+wrote:$/.test(line.trim()) ||
      /^>/.test(line) ||
      /^-{2,}\s*Original Message/i.test(line) ||
      /^_{5,}\s*$/.test(line.trim()) ||
      // Outlook: a "From:" header line followed within two lines by "Sent:" or "Date:".
      (/^\*?From:\*?\s/i.test(line.trim()) && lines.slice(index + 1, index + 3).some((next) => /^\*?(Sent|Date):\*?\s/i.test(next.trim()))),
  );
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}

export class GmailClient {
  private readonly fetch: typeof fetch;
  private accessToken: { value: string; expiresAt: number } | null = null;
  private ownAddress: string | null = null;

  constructor(private readonly options: GmailOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  consentUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async connected(): Promise<boolean> {
    return (await this.refreshToken()) !== null;
  }

  async exchangeCode(code: string): Promise<void> {
    const token = await this.tokenRequest({
      code,
      grant_type: "authorization_code",
      redirect_uri: this.options.redirectUri,
    });
    if (!token.refresh_token) throw new Error("Google did not return a refresh token.");
    await writeFile(
      this.options.tokenPath,
      JSON.stringify({ refresh_token: token.refresh_token }),
      { mode: 0o600 },
    );
    this.remember(token);
  }

  async address(): Promise<string> {
    if (this.ownAddress) return this.ownAddress;
    const profile = (await this.api("users/me/profile")) as { emailAddress: string };
    this.ownAddress = profile.emailAddress;
    return profile.emailAddress;
  }

  async send(message: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<{ threadId: string }> {
    const from = await this.address();
    const raw = [
      `From: ${from}`,
      `To: ${message.to}`,
      `Subject: ${encodeHeader(message.subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      message.body,
    ].join("\r\n");
    const sent = (await this.api("users/me/messages/send", {
      method: "POST",
      body: JSON.stringify({
        raw: base64Url(raw),
        ...(message.threadId ? { threadId: message.threadId } : {}),
      }),
    })) as { threadId: string };
    return { threadId: sent.threadId };
  }

  /** Messages in a thread that someone other than the founder sent after `since`. */
  async repliesIn(threadId: string, since: string): Promise<InboundMessage[]> {
    const own = (await this.address()).toLowerCase();
    const thread = (await this.api(`users/me/threads/${threadId}?format=full`)) as {
      messages?: {
        internalDate?: string;
        payload?: GmailPart & { headers?: { name: string; value: string }[] };
      }[];
    };
    const sinceMs = Date.parse(since);
    return (thread.messages ?? [])
      .map((message) => {
        const from =
          message.payload?.headers?.find((header) => header.name.toLowerCase() === "from")
            ?.value ?? "";
        return {
          from,
          at: new Date(Number(message.internalDate ?? 0)).toISOString(),
          text: withoutQuote(plainText(message.payload)),
        };
      })
      .filter(
        (message) =>
          addressOf(message.from) !== own &&
          Date.parse(message.at) > sinceMs &&
          message.text.length > 0,
      );
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

  private remember(token: { access_token: string; expires_in: number }) {
    this.accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + (token.expires_in - 60) * 1000,
    };
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

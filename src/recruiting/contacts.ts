import type { CandidateProfile, ContactDetails } from "./domain.js";

/**
 * Finds a work email for one candidate the founder chose to contact. Providers
 * are tried in order; the first answer wins. Only called on demand, so the free
 * tiers (Hunter 50 credits a month, Prospeo 75) cover a real search.
 */
export interface ContactFinder {
  readonly provider: ContactDetails["provider"];
  find(profile: CandidateProfile): Promise<ContactDetails | null>;
}

function currentCompany(profile: CandidateProfile): string {
  return (profile.workHistory.find((entry) => !entry.to) ?? profile.workHistory[0])?.company ?? "";
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.length > 1 ? parts.at(-1)! : "" };
}

function linkedinHandle(url: string): string | null {
  return url.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? null;
}

export class HunterFinder implements ContactFinder {
  readonly provider = "hunter" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async find(profile: CandidateProfile): Promise<ContactDetails | null> {
    const params = new URLSearchParams({ api_key: this.apiKey });
    const handle = linkedinHandle(profile.profileUrl);
    const company = currentCompany(profile);
    if (handle) params.set("linkedin_handle", handle);
    else if (company) {
      params.set("company", company);
      params.set("full_name", profile.name);
    } else return null;

    const response = await this.fetchImpl(`https://api.hunter.io/v2/email-finder?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: { email?: string | null; verification?: { status?: string | null } };
    };
    const email = body.data?.email;
    if (!email) return null;
    return {
      email,
      status: body.data?.verification?.status === "valid" ? "verified" : "found",
      provider: "hunter",
    };
  }
}

export class ProspeoFinder implements ContactFinder {
  readonly provider = "prospeo" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async find(profile: CandidateProfile): Promise<ContactDetails | null> {
    const { first, last } = splitName(profile.name);
    const data: Record<string, string> = {};
    if (linkedinHandle(profile.profileUrl)) data.linkedin_url = profile.profileUrl;
    else {
      const company = currentCompany(profile);
      if (!company || !first) return null;
      Object.assign(data, { first_name: first, last_name: last, company_name: company });
    }

    const response = await this.fetchImpl("https://api.prospeo.io/enrich-person", {
      method: "POST",
      headers: { "x-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ only_verified_email: true, data }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      person?: { email?: { email?: string; status?: string } };
    };
    const email = body.person?.email?.email;
    if (!email) return null;
    return {
      email,
      status: body.person?.email?.status === "VERIFIED" ? "verified" : "found",
      provider: "prospeo",
    };
  }
}

export async function findContact(
  finders: readonly ContactFinder[],
  profile: CandidateProfile,
  guess: () => Promise<{ email: string } | null>,
): Promise<ContactDetails | null> {
  for (const finder of finders) {
    try {
      const found = await finder.find(profile);
      if (found) return found;
    } catch {
      // A provider outage should fall through to the next one, not end the search.
    }
  }
  const guessed = await guess();
  return guessed ? { email: guessed.email, status: "unverified", provider: "guess" } : null;
}

export { currentCompany };

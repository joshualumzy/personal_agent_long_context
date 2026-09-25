import type { Evidence } from "../company-domain.js";
import type { GmailContact } from "../recruiting/gmail.js";
import type { ContactDirectory } from "./domain.js";

/** Presents Gmail header lookups as Evidence, so a found address is shown and cited like any other source. */
export function gmailContactDirectory(gmail: {
  connected(): Promise<boolean>;
  contactsNamed(name: string): Promise<GmailContact[]>;
}): ContactDirectory {
  return {
    connected: () => gmail.connected(),
    async lookup(name) {
      const contacts = await gmail.contactsNamed(name);
      return contacts.map(
        (contact): Evidence => ({
          sourceId: `gmail:${contact.email}`,
          sourceType: "gmail_contact",
          title: `Gmail contact: ${contact.name || contact.email}`,
          excerpt: `${contact.name ? `${contact.name} ` : ""}<${contact.email}> appears in ${contact.count} header(s) of the employee's recent emails.`,
        }),
      );
    },
  };
}

const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A phone written the way people write one (+65 9123 4567, (555) 123-4567, 9123 4567), never a date. */
const PHONE_IN_TEXT = /\+\d[\d\s()‐-―-]{6,}\d|\(\d{2,4}\)\s?\d[\d\s‐-―-]{5,}\d|\b\d{4}\s\d{4}\b/;

/** "Lena Gomez at Datadog" → "Lena Gomez": the name without where they work. */
export function personName(value: string): string {
  return value.split(/\s+(?:at|from|of)\s+|,|\(/i)[0]!.trim();
}

/**
 * Text right after `name` that carries that person's contact details: an
 * email whose local part contains their first or last name, or a phone
 * number within the next line or two. Someone else's address that merely
 * follows the name (a colleague listed next to them) is not taken.
 */
export function contactSnippets(text: string, name: string): string[] {
  const snippets: string[] = [];
  const lower = text.toLowerCase();
  const target = name.toLowerCase();
  const words = target.split(/\s+/).filter((word) => word.length >= 3);
  for (let at = lower.indexOf(target); at !== -1 && snippets.length < 3; at = lower.indexOf(target, at + target.length)) {
    const window = text.slice(at, at + 160).replace(/\s+/g, " ").trim();
    const ownEmail = [...window.matchAll(EMAIL_IN_TEXT)].some((match) =>
      words.some((word) => match[0].toLowerCase().split("@")[0]!.includes(word)),
    );
    const nearbyPhone = PHONE_IN_TEXT.test(text.slice(at, at + 120));
    if (ownEmail || nearbyPhone) snippets.push(window);
  }
  return snippets;
}

/**
 * Finds a person's email or phone in company records (signatures, contact
 * tables) by reading the text right after their name. Plain keyword search
 * ranks whole documents and trims excerpts, so a signature at the bottom of
 * one email is easily missed.
 */
export function companyContactDirectory(pool: {
  query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
}): ContactDirectory {
  return {
    connected: async () => true,
    async lookup(rawName) {
      const name = personName(rawName);
      if (name.length < 3) return [];
      const escaped = name.replace(/[\\%_]/g, (char) => `\\${char}`);
      const result = await pool.query<{ source_id: string; title: string | null; source_type: string; content: string }>(
        `SELECT c.source_id, d.title, d.source_type, c.content
           FROM document_chunks c JOIN source_documents d USING (source_id)
          WHERE c.content ILIKE $1
            AND c.content ~* '[a-z0-9._%+-]+@[a-z0-9-]+\\.[a-z]{2,}|\\+[0-9]|\\([0-9]{2,4}\\)|[0-9]{4} [0-9]{4}'
          LIMIT 20`,
        [`%${escaped}%`],
      );
      const found: Evidence[] = [];
      for (const row of result.rows) {
        for (const snippet of contactSnippets(row.content, name)) {
          if (found.some((item) => item.excerpt === snippet)) continue;
          found.push({ sourceId: row.source_id, sourceType: row.source_type, title: row.title ?? row.source_id, excerpt: snippet });
          break;
        }
        if (found.length >= 3) break;
      }
      return found;
    },
  };
}

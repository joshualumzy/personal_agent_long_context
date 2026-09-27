/**
 * The second layer of the Prohibited Data gate: a model asked whether a
 * message contains an actual secret value.
 *
 * The pattern rules in prohibited-data.ts are fast and never block ordinary
 * work, but each fresh set of phrasings found secrets they missed ("my IC
 * number is S99...", a Bearer header, a database URL with a password in it).
 * A model reads those the way a person does. It runs only on messages the
 * rules let through, with no tools and no memory, and nothing is stored.
 *
 * A classifier that cannot answer lets the message through: the rules still
 * ran, and a model outage must not take the chat down with it.
 */

export interface SecretClassifierOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export type SecretClassifier = (text: string) => Promise<boolean>;

const PROMPT = [
  "You check workplace chat messages before they reach an assistant that has memory.",
  "Does the message below contain an actual secret VALUE that must not be stored? Secrets are:",
  "a password, passphrase, PIN or passcode; a one-time, MFA or verification code; an API key, access or bearer token,",
  "or a connection string or URL with credentials in it; a private key; a payment card number or card security code;",
  "a bank account, IBAN, sort code, routing or SWIFT number; a government ID number (SSN, NRIC/IC/FIN, passport,",
  "driver's licence, national ID, tax number).",
  "Only the value itself counts. Talking about passwords, keys, cards or IDs without giving one is NOT a secret,",
  "nor are ticket numbers, PR numbers, dates, versions, timestamps, prices, phone extensions or other ordinary IDs.",
  "Reply with exactly one word: yes or no.",
].join(" ");

export function secretClassifier(options: SecretClassifierOptions): SecretClassifier {
  return async (text: string) => {
    try {
      const res = await fetch(`${options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: PROMPT },
            { role: "user", content: `Message:\n"""\n${text}\n"""` },
          ],
          temperature: 0,
          max_tokens: 5,
          ...(/qwen/i.test(options.model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return /^\s*yes\b/i.test(body.choices?.[0]?.message?.content ?? "");
    } catch {
      return false;
    }
  };
}

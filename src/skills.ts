import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A skill as the model first sees it: a name and when to use it. */
export interface SkillSummary {
  name: string;
  description: string;
}

export interface Skill extends SkillSummary {
  /** The SKILL.md body, loaded only when the model asks for this skill. */
  body: string;
}

export const defaultSkillsDirectory = fileURLToPath(new URL("../skills/", import.meta.url));

/** A frontmatter value: plain, quoted, or a folded (>) or literal (|) block. */
function scalar(first: string, rest: string[]): string {
  const value = first.trim();
  if (/^[>|][+-]?$/.test(value)) {
    const lines = rest.map((line) => line.trim());
    return (value.startsWith(">") ? lines.filter(Boolean).join(" ") : lines.join("\n")).trim();
  }
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

/** Splits `---` frontmatter holding `name:` and `description:` from the body. */
export function parseSkill(text: string): Skill {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) throw new Error("SKILL.md must start with --- frontmatter.");
  const fields: Record<string, string> = {};
  const lines = match[1]!.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([\w-]+):(.*)$/.exec(lines[index]!);
    if (!field) continue;
    // Indented lines that follow belong to this field (block scalars).
    const rest: string[] = [];
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) rest.push(lines[++index]!);
    fields[field[1]!] = scalar(field[2]!, rest);
  }
  if (!fields.name || !fields.description) {
    throw new Error("SKILL.md frontmatter needs name and description.");
  }
  return { name: fields.name, description: fields.description, body: (match[2] ?? "").trim() };
}

/** Reads every `<directory>/<name>/SKILL.md`. */
export async function loadSkills(
  directory = defaultSkillsDirectory,
  onInvalid?: (skill: string, error: unknown) => void,
): Promise<Skill[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(directory, entry.name, "SKILL.md"), "utf8").catch(() => null);
    if (text === null) continue;
    // One malformed skill is skipped, never a reason for the server not to start.
    try {
      skills.push(parseSkill(text));
    } catch (error) {
      onInvalid?.(entry.name, error);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

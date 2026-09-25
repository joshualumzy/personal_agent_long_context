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

/** Splits `---` frontmatter holding `name:` and `description:` from the body. */
export function parseSkill(text: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("SKILL.md must start with --- frontmatter.");
  const fields = Object.fromEntries(
    match[1]!
      .split("\n")
      .map((line) => /^(\w+):\s*(.*)$/.exec(line))
      .filter((entry): entry is RegExpExecArray => entry !== null)
      .map((entry) => [entry[1]!, entry[2]!.trim()]),
  );
  if (!fields.name || !fields.description) {
    throw new Error("SKILL.md frontmatter needs name and description.");
  }
  return { name: fields.name, description: fields.description, body: match[2]!.trim() };
}

/** Reads every `<directory>/<name>/SKILL.md`. */
export async function loadSkills(directory = defaultSkillsDirectory): Promise<Skill[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(directory, entry.name, "SKILL.md"), "utf8").catch(() => null);
    if (text !== null) skills.push(parseSkill(text));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

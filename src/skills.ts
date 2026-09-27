import { readdir, readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
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

/**
 * Frontmatter as YAML. Hand-written skill files often break strict YAML (an
 * unquoted "Use when: ..." is a YAML error), so those fall back to reading
 * one `key: value` per line, with indented continuation lines.
 */
function frontmatter(source: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(source);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the lenient reading
  }
  const fields: Record<string, string> = {};
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([\w-]+):(.*)$/.exec(lines[index]!);
    if (!field) continue;
    const rest: string[] = [];
    while (index + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[index + 1]!) && !/^[\w-]+:/.test(lines[index + 1]!)) {
      rest.push(lines[++index]!);
    }
    const value = field[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const body = rest.map((line) => line.trim());
      fields[field[1]!] = (value.startsWith(">") ? body.filter(Boolean).join(" ") : body.join("\n")).trim();
    } else {
      const joined = [value, ...rest.map((line) => line.trim())].filter(Boolean).join(" ");
      const quoted = /^(["'])([\s\S]*)\1$/.exec(joined);
      fields[field[1]!] = quoted ? quoted[2]! : joined;
    }
  }
  return fields;
}

/** Splits `---` frontmatter holding `name:` and `description:` from the body. */
export function parseSkill(text: string): Skill {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) throw new Error("SKILL.md must start with --- frontmatter.");
  const record = frontmatter(match[1]!);
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!name || !description) {
    throw new Error("SKILL.md frontmatter needs name and description.");
  }
  return { name, description, body: (match[2] ?? "").trim() };
}

/** Reads every `<directory>/<name>/SKILL.md`. */
export async function loadSkills(
  directory = defaultSkillsDirectory,
  onInvalid?: (skill: string, error: unknown) => void,
): Promise<Skill[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const entry of entries) {
    // A symlinked skill folder counts; stat follows the link.
    const isFolder = entry.isDirectory() ||
      (entry.isSymbolicLink() && (await stat(join(directory, entry.name)).catch(() => null))?.isDirectory());
    if (!isFolder) continue;
    const text = await readFile(join(directory, entry.name, "SKILL.md"), "utf8").catch(() => null);
    if (text === null) continue;
    // One malformed skill is skipped, never a reason for the server not to start.
    try {
      const skill = parseSkill(text);
      if (skills.some((existing) => existing.name === skill.name)) {
        throw new Error(`Another skill is already named ${skill.name}.`);
      }
      skills.push(skill);
    } catch (error) {
      onInvalid?.(entry.name, error);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// Round 2 hunt: src/skills.ts. "BUG" tests fail today; "NOT A BUG" tests pass.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadSkills, parseSkill } from "../../src/skills.js";

const skill = (frontmatter: string, body = "Body.") => `---\n${frontmatter}\n---\n${body}`;

describe("BUG: multi-line frontmatter values are cut short", () => {
  test("a plain description continued on an indented line loses the continuation", () => {
    const parsed = parseSkill(skill("name: demo\ndescription: Use when the founder wants to hire,\n  or asks about candidates."));
    assert.equal(parsed.description, "Use when the founder wants to hire, or asks about candidates.");
  });

  test("a double-quoted description over two lines keeps a stray quote and loses the rest", () => {
    const parsed = parseSkill(skill('name: demo\ndescription: "Use when hiring,\n  or when asked about candidates."'));
    assert.equal(parsed.description, "Use when hiring, or when asked about candidates.");
  });

  test("a block scalar with a blank line drops everything after the blank line", () => {
    const parsed = parseSkill(skill("name: demo\ndescription: |\n  First paragraph.\n\n  Second paragraph.\nlicense: MIT"));
    assert.match(parsed.description, /Second paragraph/, `got ${JSON.stringify(parsed.description)}`);
  });
});

describe("BUG: YAML escapes and comments are kept literally", () => {
  test('an escaped quote inside a double-quoted value keeps its backslash', () => {
    const parsed = parseSkill(skill('name: demo\ndescription: "Say \\"hire\\" to start."'));
    assert.equal(parsed.description, 'Say "hire" to start.');
  });

  test("a doubled single quote inside a single-quoted value stays doubled", () => {
    const parsed = parseSkill(skill("name: demo\ndescription: 'The founder''s hiring tools.'"));
    assert.equal(parsed.description, "The founder's hiring tools.");
  });

  test("a quoted value followed by a comment keeps its quotes and the comment", () => {
    const parsed = parseSkill(skill('name: "demo" # the skill id\ndescription: d'));
    assert.equal(parsed.name, "demo", `load_skill would need the name ${JSON.stringify(parsed.name)}`);
  });
});

describe("BUG: loadSkills skips symlinked skill directories", () => {
  test("a skill directory that is a symlink is silently ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "r2-skills-"));
    try {
      await mkdir(join(root, "real", "demo"), { recursive: true });
      await writeFile(join(root, "real", "demo", "SKILL.md"), skill("name: demo\ndescription: d"));
      await mkdir(join(root, "skills"));
      await symlink(join(root, "real", "demo"), join(root, "skills", "demo"), "dir");
      const invalid: string[] = [];
      const loaded = await loadSkills(join(root, "skills"), (name) => invalid.push(name));
      assert.deepEqual(loaded.map((s) => s.name), ["demo"], `skipped without a word (onInvalid: ${invalid.join(",") || "none"})`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("BUG: two skills with the same name are both loaded", () => {
  test("a duplicated name is listed twice to the model and only one can ever be loaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "r2-skills-"));
    try {
      for (const dir of ["a", "b"]) {
        await mkdir(join(root, dir));
        await writeFile(join(root, dir, "SKILL.md"), skill(`name: recruiting\ndescription: from ${dir}`, `Body ${dir}`));
      }
      const loaded = await loadSkills(root);
      assert.equal(loaded.filter((s) => s.name === "recruiting").length, 1, JSON.stringify(loaded));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("NOT A BUG (verified)", () => {
  test("body with --- lines, description with ': ' and '#', dashed keys, BOM and CRLF", () => {
    const text = "﻿---\r\nname: demo\r\nallowed-tools: x\r\ndescription: Use when: hiring #1 priority\r\n---\r\nA\r\n---\r\nB\r\n";
    const parsed = parseSkill(text);
    assert.equal(parsed.name, "demo");
    assert.equal(parsed.description, "Use when: hiring #1 priority");
    assert.equal(parsed.body, "A\n---\nB");
  });

  test("folded and literal block scalars without blank lines", () => {
    assert.equal(parseSkill(skill("name: demo\ndescription: >-\n  one\n  two")).description, "one two");
    assert.equal(parseSkill(skill("name: demo\ndescription: |\n  one\n  two")).description, "one\ntwo");
  });

  test("an indented nested key does not override a top-level one", () => {
    const parsed = parseSkill(skill("name: demo\nmetadata:\n  name: other\ndescription: d"));
    assert.equal(parsed.name, "demo");
  });

  test("a bad skill is skipped and reported, the good ones load", async () => {
    const root = await mkdtemp(join(tmpdir(), "r2-skills-"));
    try {
      await mkdir(join(root, "good"));
      await writeFile(join(root, "good", "SKILL.md"), skill("name: good\ndescription: d"));
      await mkdir(join(root, "bad"));
      await writeFile(join(root, "bad", "SKILL.md"), "no frontmatter");
      await mkdir(join(root, "dir-not-file", "SKILL.md"), { recursive: true });
      const invalid: string[] = [];
      const loaded = await loadSkills(root, (name) => invalid.push(name));
      assert.deepEqual(loaded.map((s) => s.name), ["good"]);
      assert.deepEqual(invalid, ["bad"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

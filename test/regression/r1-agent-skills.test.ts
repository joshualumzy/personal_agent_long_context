import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadSkills, parseSkill } from "../../src/skills.js";

describe("parseSkill", () => {
  test("CRLF line endings", () => {
    const skill = parseSkill("---\r\nname: a\r\ndescription: Does a.\r\n---\r\nBody line.\r\n");
    assert.deepEqual(skill, { name: "a", description: "Does a.", body: "Body line." });
  });

  test("colons in values and extra (hyphenated) fields", () => {
    const skill = parseSkill(
      "---\nname: a\ndescription: Use when: the user asks. Time 10:30.\nallowed-tools: x\nversion: 2\n---\nB",
    );
    assert.equal(skill.description, "Use when: the user asks. Time 10:30.");
    assert.equal(skill.name, "a");
  });

  test("missing body", () => {
    assert.deepEqual(parseSkill("---\nname: a\ndescription: d\n---"), { name: "a", description: "d", body: "" });
  });

  test("a UTF-8 byte order mark before the frontmatter is accepted", () => {
    const skill = parseSkill("﻿---\nname: a\ndescription: d\n---\nBody");
    assert.equal(skill.name, "a");
  });

  test("trailing spaces after a --- delimiter are accepted", () => {
    const skill = parseSkill("--- \nname: a\ndescription: d\n---  \nBody");
    assert.equal(skill.name, "a");
    assert.equal(skill.body, "Body");
  });

  test("a YAML-quoted description loses its quotes", () => {
    const skill = parseSkill('---\nname: a\ndescription: "Hiring: roles, candidates."\n---\nB');
    assert.equal(skill.description, "Hiring: roles, candidates.");
  });

  test("a YAML folded (multi-line) description is read in full", () => {
    const skill = parseSkill("---\nname: a\ndescription: >\n  Hiring for the company.\n  Use when hiring.\n---\nB");
    assert.equal(skill.description, "Hiring for the company. Use when hiring.");
  });
});

describe("loadSkills", () => {
  test("a missing directory yields no skills", async () => {
    assert.deepEqual(await loadSkills(join(tmpdir(), "definitely-missing-skills-dir-xyz")), []);
  });

  test("one malformed SKILL.md does not take down the others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-hunt-"));
    await mkdir(join(dir, "good"));
    await writeFile(join(dir, "good", "SKILL.md"), "---\nname: good\ndescription: d\n---\nBody");
    await mkdir(join(dir, "draft"));
    await writeFile(join(dir, "draft", "SKILL.md"), "# A draft with no frontmatter yet\n");
    const skills = await loadSkills(dir);
    assert.deepEqual(skills.map((s) => s.name), ["good"]);
  });
});

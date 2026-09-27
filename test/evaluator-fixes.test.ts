import test from "node:test";
import assert from "node:assert/strict";
import { getReferenceAnswer, type OrgForgeBenchmarkQuestion } from "../eval/orgforge/dataset.js";
import { evaluateQuestionResponse, parseVerdict } from "../eval/orgforge/judge.js";

test("Counterfactual references state whether the outcome depended on the cause, whatever the phrasing", () => {
  const dependent: OrgForgeBenchmarkQuestion = {
    question_id: "cf-1",
    question_type: "COUNTERFACTUAL",
    question_text: "If Deepa had not conducted the review, would Jax still have identified the gap?",
    ground_truth: { outcome_changed: true, outcome: "Jax would not have flagged a knowledge gap" },
  };
  assert.match(getReferenceAnswer(dependent)!, /would have been different.*Jax would not have flagged/);

  // An either/or question has no meaningful yes/no; the reference names the conclusion instead.
  const regardless: OrgForgeBenchmarkQuestion = {
    question_id: "cf-2",
    question_type: "COUNTERFACTUAL",
    question_text: "Was the incident dependent on Alex's incomplete knowledge, or would it have happened regardless?",
    ground_truth: { outcome_changed: false, outcome: "the incident would still have occurred" },
  };
  assert.match(getReferenceAnswer(regardless)!, /would have happened anyway/);
});

test("Perspective references follow could_actor_have_known, never keywords in the question", () => {
  // "slack_..." contains "lack", which the old keyword heuristic read as negative phrasing.
  const slackTrigger: OrgForgeBenchmarkQuestion = {
    question_id: "pers-slack",
    question_type: "PERSPECTIVE",
    question_text: "Could Chloe have encountered a knowledge gap (triggered by slack_sales_marketing_2026-03-23T09:00:00) by Day 55?",
    ground_truth: { could_actor_have_known: true },
  };
  assert.match(getReferenceAnswer(slackTrigger)!, /could have known/);

  const outside: OrgForgeBenchmarkQuestion = {
    question_id: "pers-outside",
    question_type: "PERSPECTIVE",
    question_text: "Would Janice have been outside the visibility of the design discussion by Day 3?",
    ground_truth: { could_actor_have_known: false },
  };
  assert.match(getReferenceAnswer(outside)!, /could not have known/);
});

test("Judge replies are read strictly; anything unexpected is inconclusive, not a guess", () => {
  assert.equal(parseVerdict("agrees"), "agrees");
  assert.equal(parseVerdict("  Disagrees."), "disagrees");
  assert.equal(parseVerdict("inconclusive"), "inconclusive");
  // The old parser read any reply containing "no" (e.g. "cannot", "not sure") as a verdict.
  assert.equal(parseVerdict("cannot tell"), "inconclusive");
  assert.equal(parseVerdict("no"), "inconclusive");
});

test("Evaluator Fix 3: Citation recall uses exact matching and does not inflate empty artifacts", async () => {
  const questionWithArtifacts: OrgForgeBenchmarkQuestion = {
    question_id: "recall-1",
    question_type: "PERSPECTIVE",
    question_text: "What happened?",
    ground_truth: {
      evidence_artifacts: ["slack_general_2026-03-24"],
    },
  };

  // Substring match should NOT count as a hit for slack_general
  const evalResultSubstring = await evaluateQuestionResponse(
    questionWithArtifacts,
    {
      answer: "Something happened [source:slack_general_2026-03-24_extra].",
      sources: [{ sourceId: "slack_general_2026-03-24_extra", title: "Slack" }],
      retrievedSources: [{ sourceId: "slack_general_2026-03-24_extra", title: "Slack" }],
    },
    100,
  );
  assert.equal(evalResultSubstring.citationRecall, 0, "Non-exact substring match must have recall 0");

  // Exact match counts
  const evalResultExact = await evaluateQuestionResponse(
    questionWithArtifacts,
    {
      answer: "Something happened [source:slack_general_2026-03-24].",
      sources: [{ sourceId: "slack_general_2026-03-24", title: "Slack" }],
      retrievedSources: [{ sourceId: "slack_general_2026-03-24", title: "Slack" }],
    },
    100,
  );
  assert.equal(evalResultExact.citationRecall, 1.0, "Exact match must have recall 1.0");

  // Questions without expected artifacts should NOT be awarded 1.0
  const questionWithoutArtifacts: OrgForgeBenchmarkQuestion = {
    question_id: "silence-1",
    question_type: "SILENCE",
    question_text: "Did this non-existent event occur?",
    ground_truth: {},
  };

  const evalResultNoTargets = await evaluateQuestionResponse(
    questionWithoutArtifacts,
    {
      answer: "No records indicate this event occurred.",
      sources: [],
      retrievedSources: [],
    },
    100,
  );
  assert.equal(evalResultNoTargets.citationRecall, 0, "Empty target questions must not be inflated to 1.0");
});

test("Evaluator Fix 4: Citation integrity checks against actual retrieved set", async () => {
  const question: OrgForgeBenchmarkQuestion = {
    question_id: "int-1",
    question_type: "PERSPECTIVE",
    question_text: "Did this happen?",
    ground_truth: {},
  };

  // Hallucinated citation: cited ID is NOT in retrievedSources
  const evalResultHallucinated = await evaluateQuestionResponse(
    question,
    {
      answer: "Yes it happened [source:FAKE-ID].",
      sources: [{ sourceId: "FAKE-ID", title: "Fake" }],
      retrievedSources: [{ sourceId: "REAL-ID-1", title: "Real" }],
    },
    100,
  );
  assert.equal(
    evalResultHallucinated.citationIntegrity,
    false,
    "Citation integrity must fail if cited source is not in retrievedSources",
  );

  // Legitimate citation: cited ID is in retrievedSources
  const evalResultLegit = await evaluateQuestionResponse(
    question,
    {
      answer: "Yes it happened [source:REAL-ID-1].",
      sources: [{ sourceId: "REAL-ID-1", title: "Real" }],
      retrievedSources: [{ sourceId: "REAL-ID-1", title: "Real" }],
    },
    100,
  );
  assert.equal(
    evalResultLegit.citationIntegrity,
    true,
    "Citation integrity must pass when cited source is in retrievedSources",
  );
});

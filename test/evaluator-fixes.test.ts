import test from "node:test";
import assert from "node:assert/strict";
import { getExpectedBooleanAnswer, type OrgForgeBenchmarkQuestion } from "../eval/orgforge/dataset.js";
import { evaluateQuestionResponse } from "../eval/orgforge/judge.js";

test("Evaluator Fix 1: Counterfactual polarity inversion is corrected", () => {
  const counterfactualQ1: OrgForgeBenchmarkQuestion = {
    question_id: "cf-1",
    question_type: "COUNTERFACTUAL",
    question_text: "If Deepa had not conducted the review, would Jax still have identified the gap?",
    ground_truth: {
      outcome_changed: true,
      outcome: "Jax would not have flagged a knowledge gap",
    },
  };

  const expected1 = getExpectedBooleanAnswer(counterfactualQ1);
  // outcome_changed = true means the effect did NOT occur -> Jax would NOT still have identified it -> false
  assert.equal(expected1, false, "outcome_changed: true should map to expected answer: false");

  const counterfactualQ2: OrgForgeBenchmarkQuestion = {
    question_id: "cf-2",
    question_type: "COUNTERFACTUAL",
    question_text: "If the doc gap had not existed, would the incident still have occurred?",
    ground_truth: {
      outcome_changed: false,
      outcome: "the incident would still have occurred",
    },
  };

  const expected2 = getExpectedBooleanAnswer(counterfactualQ2);
  // outcome_changed = false means outcome unchanged -> incident STILL occurred -> true
  assert.equal(expected2, true, "outcome_changed: false should map to expected answer: true");
});

test("Evaluator Fix 2: Negative visibility perspective framing is corrected", () => {
  const outsideVisibilityQ: OrgForgeBenchmarkQuestion = {
    question_id: "pers-1",
    question_type: "PERSPECTIVE",
    question_text: "Would Janice have been outside the visibility of the design discussion by Day 3?",
    ground_truth: {
      could_actor_have_known: false,
    },
  };

  assert.equal(
    getExpectedBooleanAnswer(outsideVisibilityQ),
    true,
    "could_actor_have_known: false for 'outside visibility' should expect YES (true)",
  );

  const blindSpotQ: OrgForgeBenchmarkQuestion = {
    question_id: "pers-2",
    question_type: "PERSPECTIVE",
    question_text: "Would Mike have had a blind spot around an inbound email from Nora as of Day 22?",
    ground_truth: {
      could_actor_have_known: false,
    },
  };

  assert.equal(
    getExpectedBooleanAnswer(blindSpotQ),
    true,
    "could_actor_have_known: false for 'blind spot' should expect YES (true)",
  );

  const standardQ: OrgForgeBenchmarkQuestion = {
    question_id: "pers-3",
    question_type: "PERSPECTIVE",
    question_text: "Would Alex have learned about the incident resolved event through normal channels by Day 28?",
    ground_truth: {
      could_actor_have_known: true,
    },
  };

  assert.equal(
    getExpectedBooleanAnswer(standardQ),
    true,
    "could_actor_have_known: true for positive phrasing should expect YES (true)",
  );
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

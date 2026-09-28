# SME Operating Agent: Technical Architecture Document

## 1. Executive Summary & System Overview

The SME Operating Agent is an AI-native workplace assistant engineered specifically for Small and Medium Enterprises. Unlike general-purpose chatbots, this system is designed around three strict engineering principles: **Read-only intelligence, zero-credential action handoffs, and strictly grounded company context.**

### 1.1 Architectural Paradigm
At its core, the application is built as a modular monolith using **Fastify (Node.js)** and **TypeScript**. It powers a stateless agent reasoning loop that strictly separates authoritative company facts (stored in a shared database) from persistent, user-specific working memory.

### 1.2 Core Modules
The system is divided into three interconnected agentic workflows:
* **Company Context Agent (S1):** A Retrieval-Augmented Generation (RAG) and graph-traversal engine that answers questions using inspectable company evidence.
* **Meeting Actions Drafter (S2):** An audio/transcript processing pipeline that screens live discussions for commitments, evaluates them against deterministic policy tiers, and drafts follow-up actions.
* **Recruiting Assistant (S3):** An external candidate sourcing workflow that translates hiring criteria, screens public profiles, and drafts personalized outreach.

### 1.3 Technology Stack
* **Databases:** **PostgreSQL** (with the `pgvector` extension) serves as the authoritative evidence store. **Cognee** (Ladybug Graph + LanceDB) handles local, emergent graph extraction.
* **Memory Management:** A local **Letta** App Server isolates and persists user persona state across sessions.
* **AI Models:** The reasoning loop supports a seamless dual-toggle architecture. Local development and testing are powered by **NUS SoCLaaS (Qwen 3.8 27B)**, while the production deployment utilizes **AWS Bedrock (Claude 3.5 Sonnet)** for robust enterprise-grade reasoning. 
* **Embeddings:** Amazon Titan Text Embeddings V2 (1024 dimensions).

---

## 2. Data & Knowledge Architecture

The agent's reliability depends entirely on the quality and integrity of its underlying data. The architecture implements a sophisticated multi-layer retrieval system while enforcing strict data isolation boundaries.

### 2.1 The OrgForge Synthetic Corpus
The initial deployment utilizes the **OrgForge Synthetic SME Workplace Corpus**, hosted on Hugging Face. The ingestion pipeline (`scripts/orgforge/ingest.py`) parses and normalizes nearly 5,000 workplace records across 12 distinct channels—including Slack messages, Jira tickets, Confluence pages, emails, and Zoom transcripts—into a unified PostgreSQL schema.

### 2.2 Strict Oracle Isolation
To maintain evaluation integrity and prevent data leakage, the ingestion pipeline enforces strict "Oracle Isolation." Evaluation data bundled in the OrgForge dataset (such as `sim_event` simulation states, `sim_config`, and expected answer keys) are exclusively used by offline builders or isolated evaluation runners. The runtime database explicitly rejects these oracle records, ensuring the agent cannot "cheat" by accessing ground truth data. Verification is enforced via automated SQL assertions (`npm run test:orgforge`).

### 2.3 Multi-Layer Knowledge Retrieval
To provide highly accurate, context-aware answers, the agent searches across three distinct knowledge layers:

1. **Layer 1: PostgreSQL Hybrid Search**
   The foundation is a hybrid search engine combining traditional full-text keyword search (`tsvector`) with dense semantic search using `pgvector` and Amazon Titan Embeddings. This layer quickly isolates relevant company artifacts.
2. **Layer 2: Deterministic Causal Graph**
   While raw `sim_event` records are excluded from runtime search, their structural relationships are leveraged offline to build a deterministic causal graph. Projected into `graph_nodes` and `graph_edges` tables, this graph allows the agent to trace explicit document links and project dependencies without exposing the underlying simulation mechanics.
3. **Layer 3: Cognee Emergent Cognitive Graph**
   For deep, query-specific reasoning, the system leverages **Cognee**. Instead of running heavy extraction on the entire database, the agent isolates a small "slice" of highly relevant artifacts retrieved by Layer 1. Cognee dynamically extracts entities, concepts, and emergent causal relationships from this slice using LLMs, storing them locally in its embedded Ladybug graph and LanceDB vector store. This provides query-time visualization and recall without writing back to the authoritative PostgreSQL state.

### 2.4 Date-View Planner Projection
To assist with daily planning, the architecture includes an offline projection mechanism (`orgforge_kb/build_timeline.py`). It processes historical simulation events (like department plans and ticket progress) to project `day_plan_entry` and `work_item_state` rows. This allows the S1 agent to display a personalized, historical schedule and to-do list for any given "as-of" date, providing planning context without treating the projected plan as citable company evidence.

---

## 3. Agent Design & Reasoning Loop

The system operates on an "Adaptive Chief of Staff" reasoning loop. It is designed to autonomously select tools, synthesize evidence, and acknowledge its own limitations, rather than attempting to guess answers when data is missing.

### 3.1 Strict Evidence Grounding
The core system prompt strictly enforces citation requirements. Every factual claim about the company must be supported by an explicit citation tag (e.g., `[source:CONF-ENG-239]`) referencing a document retrieved during the current execution run. If the provided tools fail to surface supporting evidence, the agent is programmed to trigger an "Insufficient Evidence" fallback, explicitly stating what information is missing rather than hallucinating a response.

### 3.2 Tool Registry & Cross-Module Bridging
The agent has access to a specialized suite of tools:
* **Context Tools:** `search_company_knowledge`, `get_related_sources`, and `view_graph_neighborhood`.
* **Recruiting Tools:** Exa API search integration, criteria evaluation, and candidate outreach drafting.
* **Knowledge-Gap Hiring Bridge:** This represents a core architectural innovation. If the S1 Context Agent detects a missing organizational capability or skill gap during its research (via graph analysis), it can programmatically invoke the `open_role_from_gap` tool. This seamlessly transitions the workflow from operational discovery in S1 directly to strategic capacity building in S3, initializing a new hiring role.

### 3.3 Persona-Scoped Letta Memory
To preserve conversational context without polluting the company knowledge base, the system integrates the **Letta App Server**. Context is strictly scoped by `employee_id`. When a user switches personas (e.g., from Jax in Backend to Priya in Design), the Letta memory seamlessly swaps. This ensures that an employee's personal working memory, preferences, and hiring criteria persist across sessions but are never cited as public corporate facts.

---

## 4. Security, Guardrails & Execution Handoff

In an SME environment lacking robust Enterprise SSO and fine-grained role-based access controls (RBAC), granting an AI agent write permissions is a severe security risk. The system circumvents this via a "Zero-Credential" architecture.

### 4.1 Zero-Credential Action Handoffs
The agent is explicitly denied write access to external APIs. Instead, when a decision is made (e.g., following up on a meeting commitment), the agent generates a prefilled draft payload. These drafts are passed to the user's browser via zero-credential protocols:
* **Emails:** Opened via `mailto:` links or web-based Gmail/Outlook compose URLs.
* **Calendar Invites:** Downloaded as `.ics` files or opened via Google Calendar event links.
* **Tickets:** Opened as prefilled GitHub issue URLs.
* **Execution:** The final "Send" or "Save" button is always clicked by the human user, acting within their own authenticated browser session.

### 4.2 Pre-Model Meeting Policy Enforcement
The S2 Meeting Actions module utilizes a deterministic tier-based policy (`src/meetings/policy.ts`). Before any meeting transcript line is sent to the LLM:
1. **Secret & Injection Screening:** Regular expressions and heuristic checks intercept lines containing passwords, API keys, or prompt injections (e.g., "ignore previous instructions"). These lines are flagged as "blocked" and entirely withheld from the LLM context.
2. **Financial Escalation:** Any commitment involving budgets, discounts, or contractual agreements bypasses standard employee approval and is automatically escalated to a designated manager tier.

---

## 5. Evaluation & Benchmarks

The architecture’s reliability is continuously verified through a comprehensive suite of automated tests and benchmark evaluations.

### 5.1 Automated Testing & Verification
The repository maintains strict TypeScript checks (`npm run typecheck`) and a suite of 76 automated unit tests (`npm test`) covering routing, parsing, and state management. The browser rendering of conversational UI and SSE streams is also tested headlessly (`npm run test:browser`).

### 5.2 Oracle Isolation Validation
To guarantee that the agent’s reasoning is based solely on permissible company artifacts, the `npm run test:orgforge` script executes SQL assertions against the PostgreSQL database. It verifies that zero raw oracle records (e.g., `sim_event`) have leaked into the runtime retrieval, chunking, embedding, or citation surfaces.

### 5.3 Meeting Action Benchmark
The S2 module is evaluated using `npm run eval:meetings` against a benchmark set of 20 edge-case transcripts. This suite tests the agent's ability to achieve 100% recall on genuine commitments while correctly identifying cross-meeting conflicts, rejecting unanswerable hypothetical questions, and blocking 100% of adversarial prompt injections.

---

## 6. Future Technical Roadmap

The prototype provides a strong, scalable foundation. Future technical milestones include:
1. **Managed Memory Infrastructure:** Transitioning Letta from a local SQLite deployment to a managed cloud endpoint to handle concurrent, multi-tenant memory streams.
2. **Expanded Sourcing Connectors:** Enhancing the S3 Recruiting module by integrating deeper API connections (e.g., GitHub, StackOverflow) beyond Exa web search to improve candidate profiling.
3. **Enterprise Access Control:** Implementing fine-grained RBAC and Enterprise SSO to allow secure, authenticated API write operations (e.g., direct Jira integration) once organizational trust is established.

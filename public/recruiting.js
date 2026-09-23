"use strict";

// Every string that came from a profile or a model is untrusted, so the page
// builds nodes and sets textContent; it never assigns innerHTML.

const SVG = "http://www.w3.org/2000/svg";
const $ = (selector) => document.querySelector(selector);

const BANDS = {
  100: { inner: 40, outer: 150, size: 26 },
  75: { inner: 190, outer: 290, size: 17 },
  50: { inner: 335, outer: 440, size: 9 },
};

let state = null;
let selectedId = null;
let detailSignature = "";
let draftCriteria = null;
let lastRoundCount = 0;
let pollTimer = null;
const nodes = new Map();

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function hash(text, seed = 0) {
  let value = 2166136261 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

// ------------------------------------------------------------------ network

function showError(message) {
  const banner = $("#error");
  banner.textContent = message;
  banner.hidden = !message;
}

async function call(path, body, button) {
  if (button) button.disabled = true;
  showError("");
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json();
    if (!response.ok) {
      showError(data.message ?? "Something went wrong.");
      return undefined;
    }
    if (data.state) render(data.state);
    return data.result;
  } catch {
    showError("The server did not answer. Is it running?");
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

async function refresh() {
  try {
    const response = await fetch("/api/recruiting/state");
    if (response.ok) render(await response.json());
  } catch {
    // The next poll tries again.
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state && (state.busy || state.memoryPending > 0);
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, busy ? 1200 : 5000);
}

// ------------------------------------------------------------------- render

function render(next) {
  state = next;
  const role = state.role;
  $("#intake").hidden = Boolean(role);
  $("#review").hidden = !role || role.confirmed;
  $("#board").hidden = !role?.confirmed;
  $("#top-actions").hidden = !role;
  $("#role-title").textContent = role ? role.title : "Who do you need?";

  if (state.lastError && !$("#error").textContent) showError(state.lastError);

  if (role && !role.confirmed) renderReview();
  if (role?.confirmed) {
    $("#say").dispatchEvent(new Event("input"));
    renderStatus();
    renderOrbit();
    renderProposals();
    renderCriteria();
    renderDetail();
  } else {
    $("#status-line").textContent = role ? "Step 2 of 2: check the criteria." : "Step 1 of 2: describe the role.";
  }
  renderTop();
}

function inPool() {
  return state.candidates.filter((candidate) => candidate.stage !== "closed" && candidate.tier !== "out" && candidate.tier !== "pending");
}

function renderStatus() {
  const pool = inPool();
  const strong = pool.filter((candidate) => candidate.tier === 100).length;
  const talking = state.candidates.filter((candidate) => ["contacted", "replied", "scheduling"].includes(candidate.stage)).length;
  const line = $("#status-line");
  line.replaceChildren();
  if (state.busy) line.append(h("span", { class: "busy-dot", "aria-hidden": "true" }));
  const parts = [`${pool.length} people in view`, `${strong} strong ${strong === 1 ? "match" : "matches"}`];
  if (talking) parts.push(`talking to ${talking}`);
  line.append(parts.join(", ") + (state.busy ? ". Thinking…" : "."));
}

function renderTop() {
  const day = state.clockOffsetDays;
  $("#clock").textContent = day ? `${day} days later` : "Today";
  const gmail = $("#gmail");
  const status = state.integrations?.gmail;
  gmail.hidden = status === null || status === undefined;
  gmail.textContent = status ? "Gmail connected" : "Connect Gmail";
  gmail.classList.toggle("on", Boolean(status));
  if (status) gmail.removeAttribute("href");
  else gmail.setAttribute("href", "/api/recruiting/gmail/connect");
  $("#sample-note").hidden = state.integrations?.source !== "sample";
}

// ------------------------------------------------------------------ review

function renderReview() {
  if (!draftCriteria) draftCriteria = state.criteria.map(({ id, text, kind }) => ({ id, text, kind }));
  const list = $("#draft-criteria");
  list.replaceChildren(
    ...draftCriteria.map((criterion, index) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: `kind-toggle ${criterion.kind}`,
            title: "Must or nice to have",
            onclick: () => {
              criterion.kind = criterion.kind === "must" ? "nice" : "must";
              renderReview();
            },
          },
          criterion.kind === "must" ? "MUST" : "NICE",
        ),
        h("input", {
          type: "text",
          value: criterion.text,
          "aria-label": `Criterion ${index + 1}`,
          oninput: (event) => {
            criterion.text = event.target.value;
          },
        }),
        h(
          "button",
          {
            type: "button",
            class: "remove",
            "aria-label": "Remove",
            onclick: () => {
              draftCriteria.splice(index, 1);
              renderReview();
            },
          },
          "×",
        ),
      ),
    ),
  );
}

function showRefused(refused) {
  const box = $("#refused");
  box.hidden = !refused?.length;
  box.replaceChildren(
    ...(refused ?? []).map((entry) =>
      h("p", {}, `Left out "${entry.text}": hiring criteria may not select on ${entry.characteristic}.`),
    ),
  );
}

// ------------------------------------------------------------------- orbit

function drawRings(root) {
  const defs = svg("defs");
  const glow = svg("radialGradient", { id: "core-glow" });
  glow.append(
    svg("stop", { offset: "0%", "stop-color": "#f2c66d", "stop-opacity": "0.14" }),
    svg("stop", { offset: "100%", "stop-color": "#f2c66d", "stop-opacity": "0.02" }),
  );
  const star = svg("filter", { id: "star-glow", x: "-80%", y: "-80%", width: "260%", height: "260%" });
  star.append(
    svg("feGaussianBlur", { stdDeviation: "6", result: "blur" }),
    Object.assign(svg("feMerge"), {}),
  );
  const merge = star.querySelector("feMerge");
  merge.append(svg("feMergeNode", { in: "blur" }), svg("feMergeNode", { in: "SourceGraphic" }));
  defs.append(glow, star);

  const rings = svg("g", { class: "rings" });
  for (const [tier, band] of Object.entries(BANDS)) {
    rings.append(svg("circle", { class: `ring r${tier}`, r: band.outer + 10 }));
  }
  rings.append(svg("circle", { class: "ripple", r: BANDS[50].outer + 30, id: "ripple" }));
  root.append(defs, rings, svg("g", { id: "nodes" }));
}

function layout(pool) {
  const positions = new Map();
  for (const tier of [100, 75, 50]) {
    const members = pool
      .filter((candidate) => candidate.tier === tier)
      .sort((left, right) => hash(left.id) - hash(right.id));
    const band = BANDS[tier];
    const offset = hash(String(tier), 7) * Math.PI * 2;
    members.forEach((candidate, index) => {
      const angle = offset + (index / Math.max(members.length, 1)) * Math.PI * 2;
      const lanes = tier === 100 && members.length <= 3 ? [0.55] : [0.3, 0.72];
      const lane = lanes[index % lanes.length];
      const radius =
        tier === 100 && members.length === 1 ? 0 : band.inner + (band.outer - band.inner) * lane;
      positions.set(candidate.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, size: band.size });
    });
  }
  return positions;
}

function renderOrbit() {
  const root = $("#orbit");
  if (!root.querySelector(".rings")) drawRings(root);
  const layer = $("#nodes");
  const pool = inPool();
  const crowdedCentre = pool.filter((candidate) => candidate.tier === 100).length > 4;
  const positions = layout(pool);
  $("#board").classList.toggle("focused", Boolean(selectedId));

  if (state.rounds.length > lastRoundCount && lastRoundCount > 0) {
    const ripple = $("#ripple");
    ripple.classList.remove("go");
    void ripple.getBoundingClientRect();
    ripple.classList.add("go");
  }
  lastRoundCount = state.rounds.length;

  for (const [id, node] of nodes) {
    if (!positions.has(id)) {
      node.classList.add("entering");
      setTimeout(() => node.remove(), 600);
      nodes.delete(id);
    }
  }

  for (const candidate of pool) {
    const position = positions.get(candidate.id);
    let node = nodes.get(candidate.id);
    if (!node) {
      node = svg("g", { class: "node entering", tabindex: 0, role: "button" });
      node.append(
        svg("circle", { class: "select-ring" }),
        svg("circle", { class: "halo" }),
        svg("circle", { class: "stage-ring" }),
        svg("circle", { class: "dot" }),
        svg("text", { class: "initials" }),
        svg("text", { class: "name" }),
        svg("title", {}),
      );
      node.addEventListener("click", () => select(candidate.id));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(candidate.id);
        }
      });
      // Enter from just outside the rings so a new search visibly arrives.
      const angle = Math.atan2(position.y, position.x) || hash(candidate.id) * Math.PI * 2;
      node.style.transform = `translate(${Math.cos(angle) * 520}px, ${Math.sin(angle) * 520}px)`;
      layer.append(node);
      nodes.set(candidate.id, node);
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("entering")));
    }
    const { size } = position;
    node.setAttribute("class", [
      "node",
      `t${candidate.tier}`,
      candidate.stage,
      candidate.kept ? "kept" : "",
      crowdedCentre ? "" : "labelled",
      candidate.settled ? "" : "provisional",
      candidate.id === selectedId ? "selected" : "",
      node.classList.contains("entering") ? "entering" : "",
    ].filter(Boolean).join(" "));
    node.querySelector(".dot").setAttribute("r", size);
    node.querySelector(".halo").setAttribute("r", size + 6);
    node.querySelector(".stage-ring").setAttribute("r", size + 11);
    node.querySelector(".select-ring").setAttribute("r", size + 17);
    const label = node.querySelector(".initials");
    label.textContent = size >= 17 ? initials(candidate.profile.name) : "";
    label.style.fontSize = size >= 26 ? "16px" : "11px";
    const name = node.querySelector(".name");
    name.textContent = candidate.profile.name;
    name.setAttribute("y", size + 24);
    node.querySelector("title").textContent = `${candidate.profile.name}, ${candidate.profile.headline}`;
    node.setAttribute("aria-label", `${candidate.profile.name}, ${candidate.tier}% match`);
    requestAnimationFrame(() => {
      node.style.transform = `translate(${position.x}px, ${position.y}px)`;
    });
  }
}

// --------------------------------------------------------------- proposals

function renderProposals() {
  $("#proposals").replaceChildren(
    ...state.proposals.map((proposal) => {
      const isCriterion = proposal.type === "criterion";
      const decide = (accept) => (event) =>
        call(`/api/recruiting/proposals/${proposal.id}`, { accept }, event.currentTarget);
      return h(
        "article",
        { class: "proposal" },
        h("h3", {}, isCriterion ? "I noticed a pattern in your passes" : `Hiring has stalled. ${proposal.stepName}?`),
        h("p", {}, proposal.rationale),
        isCriterion
          ? h("p", { class: "change" }, `Add as ${proposal.kind === "must" ? "a must" : "a nice-to-have"}: ${proposal.text}`)
          : h("p", { class: "change" }, `Next search: ${proposal.query}`),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "primary", onclick: decide(true) }, isCriterion ? "Add criterion" : "Widen the search"),
          h("button", { type: "button", class: "quiet", onclick: decide(false) }, "Not now"),
        ),
      );
    }),
  );
}

function renderCriteria() {
  $("#criteria").replaceChildren(
    ...state.criteria.map((criterion) =>
      h(
        "li",
        { class: `chip ${criterion.kind} ${criterion.origin}`, title: criterion.kind === "must" ? "Must have" : "Nice to have" },
        criterion.text,
        criterion.origin === "inferred" ? h("span", { class: "origin" }, "learned") : null,
        criterion.origin === "relaxed" ? h("span", { class: "origin" }, "relaxed") : null,
      ),
    ),
  );
}

// ------------------------------------------------------------------ drawer

let activeTab = "fit";

function select(id) {
  const next = selectedId === id ? null : id;
  if (next !== selectedId) activeTab = "fit";
  selectedId = next;
  detailSignature = "";
  renderOrbit();
  renderDetail();
}

function signature(candidate) {
  return JSON.stringify([
    activeTab,
    candidate.id,
    candidate.stage,
    candidate.tier,
    candidate.kept,
    candidate.contact,
    candidate.draft?.createdAt,
    candidate.draft?.warnings,
    candidate.messages.length,
    candidate.verdicts,
  ]);
}

const STAGE_LABEL = {
  discovered: "Found",
  scored: "Not contacted yet",
  drafted: "Draft ready",
  contacted: "Waiting for a reply",
  replied: "Replied",
  scheduling: "Setting a time",
  closed: "Closed",
};

function renderDetail() {
  const drawer = $("#drawer");
  const candidate = state.candidates.find((entry) => entry.id === selectedId);
  if (!candidate) {
    drawer.hidden = true;
    detailSignature = "";
    return;
  }
  const next = signature(candidate);
  // Keep the founder's unsent edits: only rebuild when something changed.
  if (next === detailSignature) return;
  detailSignature = next;
  drawer.hidden = false;

  const { profile } = candidate;
  const matched = candidate.tier === 100 || candidate.tier === 75 || candidate.tier === 50;
  const hasOutreach = Boolean(candidate.draft) || candidate.messages.length > 0;
  const reasonInput = h("input", { type: "text", placeholder: "Why? Optional, stays private" });
  const decision = (value) => (event) =>
    call(`/api/recruiting/candidates/${candidate.id}/feedback`, { decision: value, reason: reasonInput.value }, event.currentTarget);

  const tab = (key, label, dot = false) =>
    h(
      "button",
      {
        type: "button",
        class: "tab",
        role: "tab",
        "aria-selected": String(activeTab === key),
        onclick: () => {
          activeTab = key;
          detailSignature = "";
          renderDetail();
        },
      },
      label,
      dot ? h("span", { class: "dot", "aria-label": "has activity" }) : null,
    );

  const body = { fit: fitPanel, career: careerPanel, outreach: outreachPanel }[activeTab](candidate);

  drawer.replaceChildren(
    h(
      "div",
      { class: "drawer-head" },
      h(
        "div",
        { class: "drawer-title" },
        h("div", {}, h("h3", {}, profile.name), h("p", { class: "meta" }, [profile.headline, profile.location].filter(Boolean).join(", "))),
        h("button", { type: "button", class: "close", "aria-label": "Close", onclick: () => select(candidate.id) }, "×"),
      ),
      h(
        "div",
        { class: "facts" },
        matched ? h("span", { class: `fact match${candidate.tier}` }, `${candidate.tier}% match`) : null,
        h("span", { class: "fact" }, candidate.stage === "closed" ? `Closed: ${candidate.closedReason}` : STAGE_LABEL[candidate.stage]),
        candidate.kept ? h("span", { class: "fact match100" }, "Kept") : null,
        candidate.origin === "referral" ? h("span", { class: "fact" }, "Added by you") : null,
        candidate.origin !== "referral" && candidate.poolRound > 1 ? h("span", { class: "fact" }, "From a wider search") : null,
      ),
      candidate.stage === "closed"
        ? null
        : h(
            "div",
            { class: "decide" },
            reasonInput,
            h("button", { type: "button", class: "quiet", onclick: decision("keep") }, "Keep"),
            h("button", { type: "button", class: "quiet warn", onclick: decision("pass") }, "Pass"),
          ),
      h(
        "nav",
        { class: "tabs", role: "tablist" },
        tab("fit", "Why they fit"),
        tab("career", "Career"),
        tab("outreach", "Outreach", hasOutreach),
      ),
    ),
    h("div", { class: "drawer-body", role: "tabpanel" }, body),
  );
}

function fitPanel(candidate) {
  const mark = { yes: "✓", no: "✗", unclear: "?" };
  return h(
    "ul",
    { class: "verdicts" },
    state.criteria.map((criterion, index) => {
      const verdict = candidate.verdicts[index];
      const closed = !verdict && candidate.stage === "closed";
      return h(
        "li",
        {},
        h("span", { class: `mark ${verdict?.satisfied ?? (closed ? "closed" : "unclear")}` }, verdict ? mark[verdict.satisfied] : closed ? "·" : "…"),
        h(
          "span",
          {},
          h("span", { class: "criterion" }, criterion.text, h("small", {}, criterion.kind === "must" ? "must" : "nice to have")),
          h("span", { class: "reason" }, verdict ? verdict.reasoning : closed ? "Added after this person was closed." : "Judging…"),
        ),
      );
    }),
  );
}

function aboutText(summary) {
  // Profile text arrives as Markdown; show its About section as plain prose.
  const about = summary.split(/\n## /).find((part) => part.startsWith("About"));
  const text = (about ? about.replace(/^About\s*/, "") : "").replace(/[#*_`>]/g, "").trim();
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthYear(value) {
  const match = /^(\d{4})-(\d{2})/.exec(value ?? "");
  return match ? `${MONTHS[Number(match[2]) - 1] ?? ""} ${match[1]}`.trim() : value ?? "";
}

function span(from, to) {
  if (!from) return "";
  return `${monthYear(from)} to ${to ? monthYear(to) : "now"}`;
}

function careerPanel(candidate) {
  const { profile } = candidate;
  const about = aboutText(profile.summary);
  return h(
    "div",
    {},
    about ? h("p", { class: "about" }, about) : null,
    profile.workHistory.length ? h("h4", { class: "section-title" }, "Work") : null,
    profile.workHistory.length
      ? h(
          "ol",
          { class: "timeline" },
          profile.workHistory.map((entry) =>
            h(
              "li",
              { class: entry.from && !entry.to ? "current" : "" },
              h("span", { class: "role" }, entry.title || "Role not listed"),
              h("span", { class: "where" }, [entry.company, span(entry.from, entry.to)].filter(Boolean).join(", ")),
            ),
          ),
        )
      : null,
    profile.educationHistory.length ? h("h4", { class: "section-title" }, "Education") : null,
    profile.educationHistory.length
      ? h(
          "ol",
          { class: "timeline" },
          profile.educationHistory.map((entry) =>
            h("li", {}, h("span", { class: "role" }, entry.degree || "Degree not listed"), h("span", { class: "where" }, [entry.institution, span(entry.from, entry.to)].filter(Boolean).join(", "))),
          ),
        )
      : null,
    /^https:\/\//.test(profile.profileUrl)
      ? h("a", { class: "external", href: profile.profileUrl, target: "_blank", rel: "noopener noreferrer" }, "Open their public profile")
      : null,
  );
}

function outreachPanel(candidate) {
  const parts = [];
  if (candidate.stage === "closed") {
    parts.push(h("p", { class: "empty-note" }, `Closed: ${candidate.closedReason}.`));
  }

  if (candidate.messages.length) {
    parts.push(
      h(
        "div",
        { class: "thread" },
        candidate.messages.map((message) =>
          h(
            "div",
            { class: `bubble ${message.direction}` },
            h("small", {}, `${message.direction === "outbound" ? "You" : candidate.profile.name}, ${message.channel}, ${message.at.slice(0, 10)}`),
            message.text,
          ),
        ),
      ),
    );
  }

  if (candidate.draft) {
    const draft = candidate.draft;
    const email = h("input", { type: "email", value: candidate.contact?.email ?? "", placeholder: "Email address", "aria-label": "To" });
    const subject = h("input", { type: "text", value: draft.subject, "aria-label": "Subject" });
    const body = h("textarea", { "aria-label": "Message" }, draft.body);
    const save = () =>
      call(`/api/recruiting/candidates/${candidate.id}/draft`, {
        subject: subject.value,
        body: body.value,
        ...(email.value && email.value !== candidate.contact?.email ? { email: email.value } : {}),
      });
    const status = candidate.contact
      ? h(
          "p",
          { class: `email-status ${candidate.contact.status}` },
          candidate.contact.status === "unverified"
            ? "This address is a guess. Check it before sending."
            : `Found by ${candidate.contact.provider}${candidate.contact.status === "verified" ? " and verified" : ""}.`,
        )
      : h("p", { class: "email-status unverified" }, "No email found. Add one, or send it on LinkedIn yourself.");
    parts.push(
      h(
        "div",
        { class: "draft-box" },
        h("h4", { class: "section-title" }, { intro: "First message", follow_up: "Follow-up", scheduling: "Setting a time" }[draft.kind]),
        email,
        status,
        subject,
        body,
        draft.warnings.map((warning) => h("p", { class: "banner note" }, warning)),
        h(
          "div",
          { class: "row sticky-actions" },
          state.integrations?.gmail
            ? h("button", { type: "button", class: "primary", onclick: async (event) => { await save(); await call(`/api/recruiting/candidates/${candidate.id}/send`, {}, event.currentTarget); } }, "Send from Gmail")
            : null,
          h("button", { type: "button", class: "quiet", onclick: async (event) => { await save(); await call(`/api/recruiting/candidates/${candidate.id}/send`, { manual: true }, event.currentTarget); } }, "I sent it myself"),
          h("button", { type: "button", class: "quiet", onclick: save }, "Save edits"),
        ),
      ),
    );
  } else if (["discovered", "scored"].includes(candidate.stage)) {
    parts.push(
      h("p", { class: "empty-note" }, "Nothing sent yet. I will look up an email and write a first message for you to check."),
      h("button", { type: "button", class: "primary", onclick: async (event) => {
        const button = event.currentTarget;
        button.textContent = "Finding email and drafting…";
        await call(`/api/recruiting/candidates/${candidate.id}/outreach`, {}, button);
        button.textContent = "Find email and draft";
      } }, "Find email and draft"),
    );
  }

  if (["contacted", "replied", "scheduling"].includes(candidate.stage)) {
    const reply = h("textarea", { rows: 3, placeholder: "Paste or dictate their reply" });
    parts.push(
      h(
        "div",
        { class: "draft-box" },
        h("h4", { class: "section-title" }, "Their reply"),
        reply,
        h(
          "div",
          { class: "row" },
          h("button", { type: "button", class: "quiet", onclick: async (event) => {
            const result = await call(`/api/recruiting/candidates/${candidate.id}/reply`, { text: reply.value }, event.currentTarget);
            if (result) $("#agent-reply").textContent = result.message;
          } }, "Add reply"),
          h("button", { type: "button", class: "quiet", onclick: (event) => call(`/api/recruiting/candidates/${candidate.id}/close`, { reason: "hired" }, event.currentTarget) }, "Mark as hired"),
        ),
      ),
    );
  }
  return h("div", {}, parts);
}

// ------------------------------------------------------------------ events

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  $("#intake-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#requirement").value.trim();
    if (!text) return;
    draftCriteria = null;
    const result = await call("/api/recruiting/say", { text }, event.submitter);
    showRefused(result?.refused);
  });

  $("#jd-file").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    draftCriteria = null;
    const result = await call("/api/recruiting/upload", { filename: file.name, contentBase64: await readFile(file) });
    showRefused(result?.refused);
    event.target.value = "";
  });

  $("#add-criterion").addEventListener("click", () => {
    draftCriteria.push({ text: "", kind: "nice" });
    renderReview();
    $("#draft-criteria").lastElementChild?.querySelector("input")?.focus();
  });

  $("#confirm").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const revised = await call("/api/recruiting/criteria/draft", { criteria: draftCriteria }, button);
    if (revised === undefined) return;
    button.textContent = "Searching…";
    await call("/api/recruiting/confirm", {}, button);
    button.textContent = "Confirm and search";
    draftCriteria = null;
    showRefused([]);
    schedulePoll();
  });

  const say = $("#say");
  const sendButton = $("#say-form .send");
  const fit = () => {
    say.style.height = "auto";
    // A hidden textarea measures 0; leave it to CSS until it is on screen.
    if (say.scrollHeight > 0) say.style.height = `${Math.min(say.scrollHeight, 180)}px`;
    sendButton.disabled = !say.value.trim();
  };
  say.addEventListener("input", fit);
  fit();

  $("#say-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = say.value.trim();
    if (!text) return;
    $("#agent-reply").textContent = "…";
    // Pasted LinkedIn profile links add those people; anything else goes to the agent.
    const links = text.match(/https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^\s,]+/gi);
    const result = links
      ? await call("/api/recruiting/candidates/import", { urls: links }, sendButton)
      : await call("/api/recruiting/say", { text }, sendButton);
    if (result) {
      say.value = "";
      fit();
      $("#agent-reply").textContent = [
        result.message,
        ...(result.refused ?? []).map((entry) => `Left out "${entry.text}": criteria may not select on ${entry.characteristic}.`),
      ].join("\n");
    } else {
      $("#agent-reply").textContent = "";
    }
    schedulePoll();
  });

  say.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("#say-form").requestSubmit();
    }
  });

  for (const hint of document.querySelectorAll(".hint")) {
    hint.addEventListener("click", () => {
      say.value = hint.textContent;
      fit();
      say.focus();
    });
  }

  $("#fast-forward").addEventListener("click", async (event) => {
    await call("/api/recruiting/fast-forward", { days: 7 }, event.currentTarget);
    schedulePoll();
  });

  $("#reset").addEventListener("click", async (event) => {
    if (event.currentTarget.dataset.armed !== "yes") {
      event.currentTarget.dataset.armed = "yes";
      event.currentTarget.textContent = "Click again to erase";
      return;
    }
    event.currentTarget.dataset.armed = "";
    event.currentTarget.textContent = "Start over";
    selectedId = null;
    draftCriteria = null;
    for (const node of nodes.values()) node.remove();
    nodes.clear();
    lastRoundCount = 0;
    await call("/api/recruiting/reset", {}, event.currentTarget);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedId) select(selectedId);
  });

  refresh().then(schedulePoll);
});

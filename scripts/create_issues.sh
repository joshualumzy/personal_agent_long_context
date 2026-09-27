#!/usr/bin/env bash
# Create GitHub issues from a drafts file: one map issue plus its tickets.
#
#   scripts/create_issues.sh [drafts.md]          # default: docs/agents/asof-planner-issues.md
#   DRY_RUN=1 scripts/create_issues.sh            # print what would be created, touch nothing
#
# Drafts format: sections separated by a line "---"; each section starts with
# "## MAP — <title>" or "## T<n> — <title>". In bodies, "#MAP" and "#T<n>" are
# replaced with the real issue numbers. The map's "- [ ] T<n> ..." lines become
# "- [ ] #<number> ...". Where GitHub allows it, tickets are also linked as
# sub-issues of the map and "Blocked by" becomes a native dependency.
#
# Needs: gh (signed in: `gh auth login`), python3. Run from inside the repo.
set -euo pipefail

DRAFTS="${1:-docs/agents/asof-planner-issues.md}"
MAP_LABEL="wayfinder:map"
TICKET_LABELS=("wayfinder:task" "ready-for-agent")

[[ -f "$DRAFTS" ]] || { echo "No drafts file: $DRAFTS" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
if [[ -z "${DRY_RUN:-}" ]]; then
  command -v gh >/dev/null || { echo "gh is required: brew install gh && gh auth login" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: run gh auth login" >&2; exit 1; }
fi

export DRAFTS MAP_LABEL
export TICKET_LABELS_CSV="$(IFS=,; echo "${TICKET_LABELS[*]}")"

python3 - <<'PY'
import json, os, re, subprocess, sys

drafts = open(os.environ["DRAFTS"], encoding="utf-8").read()
dry = bool(os.environ.get("DRY_RUN"))
map_label = os.environ["MAP_LABEL"]
ticket_labels = [l for l in os.environ["TICKET_LABELS_CSV"].split(",") if l]

# --- parse -------------------------------------------------------------------
sections = []
for chunk in re.split(r"^---\s*$", drafts, flags=re.M):
    m = re.search(r"^## (MAP|T\d+) — (.+)$", chunk, flags=re.M)
    if not m:
        continue  # the file's own preamble
    body = chunk[m.end():].strip() + "\n"
    sections.append({"key": m.group(1), "title": m.group(2).strip(), "body": body})

keys = [s["key"] for s in sections]
if keys.count("MAP") != 1 or keys[0] != "MAP":
    sys.exit("The drafts need exactly one '## MAP — ...' section, first.")
tickets = sections[1:]
print(f"Found map + {len(tickets)} tickets in {os.environ['DRAFTS']}")

# --- gh helpers --------------------------------------------------------------
def gh(*args, input=None):
    if dry:
        print("  [dry-run] gh", " ".join(a if len(a) < 60 else a[:57] + "..." for a in args))
        return ""
    out = subprocess.run(["gh", *args], input=input, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip())
    return out.stdout.strip()

def try_gh(*args):
    try:
        gh(*args)
        return True
    except RuntimeError as e:
        print(f"  (skipped: {(str(e).splitlines() or ['error'])[0]})")
        return False

counter = iter(range(900, 1000))
def create(title, body, labels):
    args = ["issue", "create", "--title", title, "--body-file", "-"]
    for l in labels:
        args += ["--label", l]
    url = gh(*args, input=body)
    number = next(counter) if dry else int(url.rstrip("/").rsplit("/", 1)[-1])
    print(f"  #{number}  {title}")
    return number

repo = "OWNER/REPO" if dry else gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
print(f"Repository: {repo}")

def db_id(number):
    return 0 if dry else int(gh("api", f"repos/{repo}/issues/{number}", "--jq", ".id"))

# --- labels ------------------------------------------------------------------
for label in [map_label, *ticket_labels]:
    try_gh("label", "create", label, "--force", "--description", "wayfinder / triage")

# --- create ------------------------------------------------------------------
numbers = {}
map_sec = sections[0]
print("Creating map:")
numbers["MAP"] = create(map_sec["title"], map_sec["body"], [map_label])

def fill(text):
    # Longest keys first so "#T10" is not read as "#T1" + "0".
    for key in sorted(numbers, key=len, reverse=True):
        text = re.sub(rf"#{key}\b", f"#{numbers[key]}", text)
    return text

print("Creating tickets:")
for t in tickets:
    body = fill(t["body"])
    unresolved = re.findall(r"#(?:MAP|T\d+)\b", body)
    if unresolved:
        print(f"  warning: {t['key']} refers to {sorted(set(unresolved))}, not created yet (order the drafts so blockers come first)")
    numbers[t["key"]] = create(t["title"], body, ticket_labels)

# --- map task list -----------------------------------------------------------
map_body = map_sec["body"]
for t in tickets:
    map_body = re.sub(rf"^(- \[ \] ){t['key']}\b", rf"\g<1>#{numbers[t['key']]}", map_body, flags=re.M)
map_body = fill(map_body)
print("Updating the map's ticket list")
gh("issue", "edit", str(numbers["MAP"]), "--body-file", "-", input=map_body)

# --- native sub-issues and dependencies (optional; skipped where unsupported) --
print("Linking sub-issues:")
for t in tickets:
    if try_gh("api", "--method", "POST", f"repos/{repo}/issues/{numbers['MAP']}/sub_issues",
              "-F", f"sub_issue_id={db_id(numbers[t['key']])}"):
        print(f"  #{numbers[t['key']]} under #{numbers['MAP']}")

print("Adding blocked-by dependencies:")
for t in tickets:
    line = re.search(r"Blocked by:([^\n]*)", t["body"])
    if not line:
        continue
    for blocker in re.findall(r"#(T\d+|MAP)\b", line.group(1)):
        if blocker in numbers:
            if try_gh("api", "--method", "POST",
                      f"repos/{repo}/issues/{numbers[t['key']]}/dependencies/blocked_by",
                      "-F", f"issue_id={db_id(numbers[blocker])}"):
                print(f"  #{numbers[t['key']]} blocked by #{numbers[blocker]}")

print("\nDone:")
for key in ["MAP", *[t["key"] for t in tickets]]:
    print(f"  {key:>4} → #{numbers[key]}")
PY

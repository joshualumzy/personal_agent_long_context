"""Round 8 restores focus and caret after a drawer rebuild, but an email input has no selection API
(selectionStart is null and setSelectionRange throws), so only focus() runs. The founder is typing an address
into the draft's "To" box for someone with no email found; while people are scored the page polls every 1.2 s
and a rebuild lands mid-address. Every key typed after it must still land where the founder was typing.
The state is answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r19 an address typed into the draft's To box is scrambled by a drawer rebuild")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
draft = {"kind": "intro", "subject": "Hello", "body": "Hi Alice", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "drafted"
        c["draft"] = draft
current = {"state": base}
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    to = "#drawer input[aria-label='To']"
    page.click(to)
    page.keyboard.type("alice@exa")
    later = json.loads(json.dumps(base))
    later["criteria"].append({"id": "c3", "text": "Go", "kind": "nice", "origin": "stated", "active": True, "createdAt": "2026-09-21T00:00:00Z"})
    for c in later["candidates"]:
        c["verdicts"].append({"criterionId": "c3", "satisfied": "unclear", "reasoning": "not stated"})
    current["state"] = later
    page.evaluate("() => refresh()")
    page.wait_for_timeout(400)
    page.keyboard.type("mple.com")
    page.wait_for_timeout(200)
    value = page.input_value(to)
    r.check("alice@exa" in value, f"control: the part typed before the rebuild is kept ({value!r})")
    r.check(value == "alice@example.com", f"the address reads as typed ({value!r})")
r.finish(console)

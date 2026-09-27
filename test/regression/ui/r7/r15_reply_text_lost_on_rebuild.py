"""Round 5 kept typed draft text across drawer rebuilds, but the "Their reply" box (and the Keep/Pass reason)
are still plain inputs rebuilt from nothing. The founder pastes a candidate's reply; a poll brings a change
that is in the drawer's signature (here a rescore after a criterion was added: new verdicts), the drawer is
rebuilt, and the pasted reply is gone before "Add reply" is pressed. The state is answered by the test."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r15 a reply pasted into the drawer is lost when a poll rebuilds it")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "contacted"
        c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
        c["messages"] = [{"direction": "outbound", "channel": "email", "at": "2026-09-10T00:00:00Z", "text": "Hi Alice"}]
current = {"state": base}
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    reply = "#drawer textarea[placeholder^='Paste or dictate']"
    page.fill(reply, "Thanks, happy to talk on Tuesday.")
    page.fill("#drawer .decide input", "strong TypeScript")
    # A criterion was added meanwhile; the poll brings Alice's new verdicts.
    later = json.loads(json.dumps(base))
    later["criteria"].append({"id": "c3", "text": "Go", "kind": "nice", "origin": "stated", "active": True, "createdAt": "2026-09-21T00:00:00Z"})
    for c in later["candidates"]:
        c["verdicts"].append({"criterionId": "c3", "satisfied": "unclear", "reasoning": "not stated"})
    current["state"] = later
    page.evaluate("() => refresh()")
    page.wait_for_timeout(500)
    r.check(page.locator("#drawer").is_visible(), "control: Alice's drawer is still open")
    value = page.input_value(reply) if page.locator(reply).count() else None
    r.check(value == "Thanks, happy to talk on Tuesday.", f"the pasted reply is still in the box (now {value!r})")
    reason = page.input_value("#drawer .decide input") if page.locator("#drawer .decide input").count() else None
    r.check(reason == "strong TypeScript", f"the typed Keep/Pass reason is still there (now {reason!r})")
r.finish(console)

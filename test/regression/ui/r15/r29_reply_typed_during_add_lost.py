"""A pasted reply is read by the model, which takes seconds; the reply box stays editable meanwhile. When the
answer comes, "Add reply" forgets the box's kept text unconditionally (`typedFields.delete(replyKey)`) and act()
rebuilds the drawer, so the box comes back empty: anything pasted or typed into it after the press (the
candidate's second message, say) is gone. Round 6 fixed the same thing for draft edits ("forget the typed
text only if nothing was typed after it went out"); the reply box and the pass reason were left out.
The state, the reply and its answer are handled by the test.
Passes if the text added to the box after pressing "Add reply" is still there once the reply is recorded."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r29 text typed into the reply box while a reply is being added is wiped")
a = "rolea"
base = state(a)
alice = next(c for c in base["candidates"] if c["profile"]["name"] == "Alice Tan")


def staged(messages):
    later = json.loads(json.dumps(base))
    for c in later["candidates"]:
        if c["id"] == alice["id"]:
            c["stage"] = "contacted" if len(messages) == 1 else "replied"
            c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
            c["draft"] = None
            c["messages"] = messages
    return later


OUT = {"direction": "outbound", "channel": "email", "at": "2026-09-01T00:00:00Z", "text": "Hi Alice,"}
FIRST = "Yes, happy to talk."
current = {"state": staged([OUT])}
held = []

with browser_page(1920, 1080) as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.route(f"**/api/recruiting/roles/{a}/candidates/*/reply", lambda route: held.append(route))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.locator("#nodes .node[aria-label^='Alice Tan']").click()
    page.wait_for_selector("#drawer:not([hidden]) h3")
    page.click("#drawer .tab:has-text('Outreach')")
    reply = page.locator("#drawer textarea[placeholder^='Paste or dictate']")
    reply.wait_for(timeout=5000)
    reply.fill(FIRST)
    page.click("#drawer button:has-text('Add reply')")
    page.wait_for_timeout(300)
    r.check(len(held) == 1, f"control: the reply is being read ({len(held)})")
    # Meanwhile the founder pastes the candidate's next message into the box.
    reply = page.locator("#drawer textarea[placeholder^='Paste or dictate']")
    reply.fill("Also: Thursday 3pm works for me.")
    current["state"] = staged([OUT, {"direction": "inbound", "channel": "pasted", "at": "2026-09-02T00:00:00Z", "text": FIRST}])
    held[0].fulfill(status=200, content_type="application/json",
                    body=json.dumps({"result": {"intent": "reply", "message": "Recorded Alice's reply."}, "state": current["state"]}))
    page.wait_for_timeout(800)
    left = page.locator("#drawer textarea[placeholder^='Paste or dictate']").input_value()
    r.check("Thursday 3pm" in left, f"the text added after pressing 'Add reply' is still in the box (box now: {left!r})")
r.finish(console, allow_console=True)

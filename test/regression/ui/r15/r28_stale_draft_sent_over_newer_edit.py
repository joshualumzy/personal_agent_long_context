"""The drawer is rebuilt only when its signature changes, and the signature holds the draft's createdAt but not its
subject or body. A draft edited and saved somewhere else (the full page in another tab, another panel in the chat)
keeps its createdAt, so this drawer keeps showing the old text for good, polls or not. Pressing a send button here
then saves what the boxes show (the old text) over the newer edit and sends it: the candidate gets the version
the founder had already corrected.
The page's state is answered by the test: Alice's draft body changes in place (same createdAt) after the drawer
is open. The save and the send are answered by the test and recorded.
Passes if the message saved for sending is not the outdated text."""
import _setup  # noqa: F401
import json
from common import *
from _r14 import with_drafted_alice

r = Result("r28 a draft edited elsewhere is overwritten by the stale text this drawer still shows, then sent")
a = "rolea"
base = state(a)
alice = next(c for c in base["candidates"] if c["profile"]["name"] == "Alice Tan")
OLD = "Hi Alice, old version with a typo."
NEW = "Hi Alice, corrected version."
current = {"state": with_drafted_alice(base, alice["id"], body=OLD)}
saved = []
sent = []


def on_draft(route):
    saved.append(json.loads(route.request.post_data or "{}"))
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": None, "state": current["state"]}))


def on_send(route):
    sent.append(route.request.post_data)
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": None, "state": current["state"]}))


with browser_page(1920, 1080) as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.route(f"**/api/recruiting/roles/{a}/candidates/*/draft", on_draft)
    page.route(f"**/api/recruiting/roles/{a}/candidates/*/send", on_send)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.locator("#nodes .node[aria-label^='Alice Tan']").click()
    page.wait_for_selector("#drawer:not([hidden]) h3")
    page.click("#drawer .tab:has-text('Outreach')")
    body = page.locator("#drawer textarea[aria-label='Message']")
    body.wait_for(timeout=5000)
    r.check(body.input_value() == OLD, f"control: the drawer shows the draft ({body.input_value()!r})")
    # The founder corrects the draft elsewhere; the draft keeps its createdAt.
    current["state"] = with_drafted_alice(base, alice["id"], body=NEW)
    page.wait_for_timeout(6500)  # more than one 5 s poll
    polled_text = body.input_value()
    page.click("#drawer button:has-text('I sent it myself')")
    page.wait_for_timeout(800)
    r.check(len(sent) == 1, f"control: the send went out once ({len(sent)})")
    posted = saved[-1].get("body") if saved else None
    r.check(posted != OLD,
            f"the message saved for sending is not the outdated text (drawer showed {polled_text!r}; saved body {posted!r})")
r.finish(console, allow_console=True)

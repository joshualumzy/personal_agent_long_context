"""The pasted-reply box (typedFields ...:reply) is cleared only by "Add reply". A founder who pastes the
candidate's "Yes, I accept!" and then presses "Mark as hired" (the obvious next step) closes the candidate:
the reply box is no longer drawn, but the typed text stays in typedFields, invisible and unreachable.
hasUnsavedText keeps reporting it, so the panel never folds and polls the server for as long as the chat is open.
The panel's state and the close are answered by the test.
Passes if, after the hire and a new panel, the old panel no longer polls."""
import _setup  # noqa: F401
import json
from common import *
from _r14 import open_panel, new_panel_then_count_polls, INIT

r = Result("c37 a pasted reply left behind by 'Mark as hired' keeps the panel live and polling forever")
a = "rolea"
base = state(a)
alice = base["candidates"][0]


def staged(stage, closed=None):
    later = json.loads(json.dumps(base))
    for c in later["candidates"]:
        if c["id"] == alice["id"]:
            c["stage"] = stage
            c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
            c["draft"] = None
            c["messages"] = [{"direction": "outbound", "channel": "email", "at": "2026-09-01T00:00:00Z", "text": "Hi Alice,"}]
            if closed:
                c["closedReason"] = closed
    return later


current = {"state": staged("contacted")}
closes = []


def on_close(route):
    closes.append(route.request.post_data)
    current["state"] = staged("closed", "hired")
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": None, "state": current["state"]}))


with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.route(f"**/api/recruiting/roles/{a}/candidates/*/close", on_close)
    page.goto(f"{BASE}/")
    old_frame = open_panel(page, {"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": alice["id"]})
    panel = page.frame_locator(".chat-block.live iframe")
    reply = panel.locator("#drawer textarea[placeholder^='Paste or dictate']")
    try:
        reply.wait_for(timeout=15000)
    except Exception:
        panel.locator("#drawer .tab:has-text('Outreach')").click()
        reply.wait_for(timeout=5000)
    reply.click()
    page.keyboard.type("Yes, I accept the offer!")
    panel.locator("#drawer button:has-text('Mark as hired')").click()
    page.wait_for_timeout(500)
    gone = old_frame.eval_on_selector_all("#drawer textarea[placeholder^='Paste or dictate']", "els => els.length") == 0
    r.check(len(closes) == 1 and gone, f"control: Alice was marked hired and the reply box is gone (closes: {len(closes)}, box gone: {gone})")
    polls, live = new_panel_then_count_polls(page, old_frame, a)
    r.check(polls == 0, f"the old panel, whose reply box no longer exists, stops polling ({polls} state requests from it in 11 s; live panels: {live})")
r.finish(console, allow_console=True)

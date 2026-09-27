"""typedDrafts is keyed by the draft's createdAt, and an entry is only removed by this panel's own save. When the
draft is replaced from elsewhere (the founder asks the agent in the chat to rewrite it shorter, or sends it from
the full page), the next poll shows the new draft and the old entry can never be shown again. hasUnsavedText
still counts it, so the panel stays live and keeps polling for as long as the chat is open, while it shows
nothing unsaved at all.
The panel's state is answered by the test: Alice's draft is replaced by a newer one after the edit.
Passes if, once the panel shows the new draft and a new panel arrives, the old panel no longer polls."""
import _setup  # noqa: F401
import json
from common import *
from _r14 import with_drafted_alice, open_panel, new_panel_then_count_polls, INIT

r = Result("c36 an edit to a draft that was since replaced keeps the panel live and polling forever")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
current = {"body": json.dumps(with_drafted_alice(base, alice["id"]))}
REWRITTEN = "Hi Alice, short version."

with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=current["body"]))
    page.goto(f"{BASE}/")
    old_frame = open_panel(page, {"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": alice["id"]})
    panel = page.frame_locator(".chat-block.live iframe")
    body = panel.locator("#drawer textarea[aria-label='Message']")
    body.wait_for(timeout=15000)
    body.click()
    page.keyboard.press("End")
    page.keyboard.type(" I loved your talk.")
    # The agent rewrites the draft (a new draft, new createdAt); the next poll shows it.
    current["body"] = json.dumps(with_drafted_alice(base, alice["id"], created="2026-09-02T00:00:00Z", body=REWRITTEN))
    page.click("#message-input")
    old_frame.wait_for_function(f"() => document.querySelector(\"#drawer textarea[aria-label='Message']\")?.value === {REWRITTEN!r}", timeout=12000)
    r.check(True, "control: the panel now shows the rewritten draft")
    polls, live = new_panel_then_count_polls(page, old_frame, a)
    r.check(polls == 0, f"the old panel, showing nothing unsaved, stops polling ({polls} state requests from it in 11 s; live panels: {live})")
r.finish(console, allow_console=True)

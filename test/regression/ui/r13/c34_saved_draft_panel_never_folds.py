"""The other side of round 12's holdsUnsavedText: "Save edits" stores the edited draft, but the drawer is not
rebuilt (its signature holds the draft's createdAt, not its text), so the message box still differs from its
defaultValue. The panel counts as holding unsaved text for as long as it exists: every later panel leaves it
live, and it keeps polling the server every 5 s (1.2 s while busy) although nothing in it is unsaved. Each
saved draft adds another board that never stops polling.
The chat stream is scripted in the page; the panel's state and the save are answered by the test.
Passes if, after the save and a new panel, the old panel no longer polls."""
import _setup  # noqa: F401
import json
from common import *
from chatfake import turn
from _chatfake4 import INIT

EDIT = " I loved your talk on queues."

r = Result("c34 a panel whose draft edit was saved stays live and polling forever")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "drafted"
        c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
        c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Hi Alice,", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
current = {"state": base}
saves = []


def on_draft(route):
    sent = json.loads(route.request.post_data)
    saves.append(sent)
    later = json.loads(json.dumps(current["state"]))
    for c in later["candidates"]:
        if c["id"] == alice["id"]:
            c["draft"]["body"] = sent["body"]
            c["draft"]["subject"] = sent["subject"]
    current["state"] = later
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": None, "state": later}))


with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.route(f"**/api/recruiting/roles/{a}/candidates/*/draft", on_draft)
    page.goto(f"{BASE}/")
    block = {"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": alice["id"]}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is Alice's draft.", [block], conversation_id="cA"))
    page.fill("#message-input", "show me alice's draft")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('.chat-block.live iframe')")
    old_frame = page.query_selector(".chat-block iframe").content_frame()
    panel = page.frame_locator(".chat-block.live iframe")
    body = panel.locator("#drawer textarea[aria-label='Message']")
    body.wait_for(timeout=15000)
    body.click()
    page.keyboard.press("End")
    page.keyboard.type(EDIT)
    panel.locator("#drawer button:has-text('Save edits')").click()
    page.wait_for_timeout(500)
    r.check(len(saves) == 1 and EDIT in saves[0]["body"], f"control: the edit was saved ({saves})")
    # Ask something else; the answer shows the pool in a new panel.
    pool = {"type": "recruiting", "view": "pool", "roleId": a}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is everyone.", [pool], conversation_id="cA"))
    page.click("#message-input")
    page.keyboard.type("who else is there?")
    page.keyboard.press("Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Here is everyone.')")
    page.wait_for_timeout(500)
    polls = []
    page.on("request", lambda request: request.url.endswith("/state") and request.frame == old_frame and polls.append(request.url))
    page.wait_for_timeout(11000)
    live = len(page.query_selector_all(".chat-block.live"))
    r.check(not polls, f"the old panel, with nothing unsaved, stops polling ({len(polls)} state requests from it in 11 s; live panels: {live})")
r.finish(console, allow_console=True)

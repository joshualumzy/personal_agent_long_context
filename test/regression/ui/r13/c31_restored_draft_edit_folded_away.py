"""Round 12 keeps a panel live when it "holds unsaved text", judged by box.value !== box.defaultValue. But the
drawer restores unsaved draft edits (typedDrafts) by building the new boxes with that text as their *initial*
content: the email and subject inputs get it as the value attribute, the message textarea as its child text.
So after any drawer rebuild (the founder glances at the Career tab and comes back, presses Keep, a poll brings
new verdicts) the edited draft is its own defaultValue and counts as untouched. The founder then asks the
agent something in the composer; the answer's new panel folds this one, its iframe goes, and the edited
message is gone ("Show this panel" reopens the saved draft).
The chat stream is scripted in the page; the panel's state is answered by the test (Alice has a draft).
Passes if the edited message is still on screen afterwards, or comes back when the old panel is reopened."""
import _setup  # noqa: F401
import json
from common import *
from chatfake import turn
from _chatfake4 import INIT

EDIT = " I loved your talk on queues."

r = Result("c31 a draft edit restored by a drawer rebuild is thrown away when a new panel arrives")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "drafted"
        c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
        c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Hi Alice,", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
STATE = json.dumps(base)


def typed_values(page):
    values = []
    for f in page.query_selector_all(".chat-block iframe"):
        content = f.content_frame()
        if content:
            values += content.eval_on_selector_all("input, textarea", "els => els.map(e => e.value)")
    return values


def edited(values):
    return any(EDIT.strip() in value for value in values)


with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=STATE))
    page.goto(f"{BASE}/")
    block = {"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": alice["id"]}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is Alice's draft.", [block], conversation_id="cA"))
    page.fill("#message-input", "show me alice's draft")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('.chat-block.live iframe')")
    panel = page.frame_locator(".chat-block.live iframe")
    body = panel.locator("#drawer textarea[aria-label='Message']")
    body.wait_for(timeout=15000)
    # The founder adds a line to the message...
    body.click()
    page.keyboard.press("End")
    page.keyboard.type(EDIT)
    # ...checks her career, and comes back to the draft (the drawer is rebuilt twice, edit kept).
    panel.locator("#drawer .tab:has-text('Career')").click()
    panel.locator("#drawer .tab:has-text('Outreach')").click()
    page.wait_for_timeout(200)
    r.check(edited(typed_values(page)), f"control: the edit is back in the draft after the tab switch ({typed_values(page)})")
    # Then asks the agent something; the answer shows the whole pool.
    pool = {"type": "recruiting", "view": "pool", "roleId": a}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is everyone.", [pool], conversation_id="cA"))
    page.click("#message-input")
    page.keyboard.type("who else is there?")
    page.keyboard.press("Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Here is everyone.')")
    page.wait_for_timeout(800)
    values = typed_values(page)
    folded = page.query_selector_all(".chat-block-reopen")
    if not edited(values) and folded:
        # A remedy may restore the text when the panel is reopened instead of keeping it open.
        for button in folded:
            button.click()
        page.wait_for_timeout(300)
        for f in page.query_selector_all(".chat-block.live iframe"):
            content = f.content_frame()
            if content:
                try:
                    content.wait_for_selector("#board:not([hidden])", timeout=10000)
                except Exception:
                    pass
        page.wait_for_timeout(2500)
        values = typed_values(page)
    r.check(edited(values), f"the edited message is still on screen, or back once its panel is reopened (values in frames: {values})")
r.finish(console, allow_console=True)

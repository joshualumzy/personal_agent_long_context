"""Round 9 (c22) stopped a new panel from folding the panel the founder is typing in, but "typing in" is read
only from where focus is at that moment. The usual order is the other one: the founder types in the current
panel (a pass reason, an edited draft), then clicks the composer and asks the agent something. Focus is now in
the composer, so when the answer brings its own panel, mountPanel folds the old one: its iframe is destroyed
with the unsaved text, and "Show this panel" reopens it empty. Nothing warned that the text would go.
The chat stream is scripted in the page; the panels read the seeded server.
Passes if the typed reason is still on screen afterwards, or comes back when the old panel is reopened."""
import _setup  # noqa: F401
from common import *
from chatfake import event, turn
from _chatfake4 import INIT

TYPED = "too junior for this role"

r = Result("c29 text typed in a panel is thrown away when the founder then asks the agent something")
a = "rolea"
alice = state(a)["candidates"][0]


def typed_values(page):
    values = []
    for f in page.query_selector_all(".chat-block iframe"):
        content = f.content_frame()
        if content:
            values += content.eval_on_selector_all("input, textarea", "els => els.map(e => e.value)")
    return values


with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    block = {"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": alice["id"]}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is Alice.", [block], conversation_id="cA"))
    page.fill("#message-input", "show me alice")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('.chat-block.live iframe')")
    reason = page.frame_locator(".chat-block.live iframe").locator("#drawer input[placeholder^='Why?']")
    reason.wait_for(timeout=15000)
    # The founder writes a pass reason in Alice's panel, not yet pressing Pass...
    reason.click()
    page.keyboard.type(TYPED)
    page.wait_for_timeout(200)
    r.check(TYPED in typed_values(page), "control: the reason is typed in the panel")
    # ...then goes to the composer and asks something; the answer shows the whole pool.
    pool = {"type": "recruiting", "view": "pool", "roleId": a}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is everyone.", [pool], conversation_id="cA"))
    page.click("#message-input")
    page.keyboard.type("who else is there?")
    page.keyboard.press("Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Here is everyone.')")
    page.wait_for_timeout(800)
    values = typed_values(page)
    folded = page.query_selector_all(".chat-block-reopen")
    if TYPED not in values and folded:
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
    r.check(TYPED in values,
            f"the unsaved pass reason is still on screen, or back once its panel is reopened (values in frames: {values})")
r.finish(console, allow_console=True)

"""holdsUnsavedText (round 12) only looks at the boxes on screen. The drawer keeps a pass reason or pasted
reply per person (typedFields) and a draft edit per person (typedDrafts) when the founder opens someone else,
but those are not in any box while another person's drawer is open. So: the founder writes why they would
pass on Alice, clicks Bob to compare before deciding, then asks the agent something. The new panel folds this
one (nothing unsaved is visible), and Alice's reason is gone when they come back to her.
The chat stream is scripted in the page; the panels read the seeded server.
Passes if Alice's reason is there when her drawer is opened again, in the old panel or once it is reopened."""
import _setup  # noqa: F401
from common import *
from chatfake import turn
from _chatfake4 import INIT

TYPED = "wants a fully remote role"

r = Result("c33 a reason typed for one person is thrown away when another person's drawer is open as a new panel arrives")
a = "rolea"
alice, bob = state(a)["candidates"][:2]


def alice_reason(frame):
    """Opens Alice's drawer in this panel (unless open) and reads her reason box."""
    frame.wait_for_selector("#board:not([hidden]) #nodes .node", timeout=15000)
    frame.wait_for_timeout(1500)
    if frame.eval_on_selector("#drawer", "d => d.hidden ? '' : (d.querySelector('h3')?.textContent || '')") != alice["profile"]["name"]:
        frame.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    frame.wait_for_selector("#drawer:not([hidden]) input[placeholder^='Why?']", timeout=5000)
    return frame.input_value("#drawer input[placeholder^='Why?']")


with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    block = {"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": alice["id"]}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is Alice.", [block], conversation_id="cA"))
    page.fill("#message-input", "show me alice")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('.chat-block.live iframe')")
    first = page.query_selector(".chat-block iframe").content_frame()
    first.wait_for_selector("#drawer input[placeholder^='Why?']", timeout=15000)
    first.wait_for_timeout(1500)
    first.click("#drawer input[placeholder^='Why?']")
    page.keyboard.type(TYPED)
    # Compare with Bob before deciding.
    first.click(f"#nodes .node[aria-label^='{bob['profile']['name']},']")
    first.wait_for_function(f"() => document.querySelector('#drawer h3')?.textContent === {bob['profile']['name']!r}")
    # Then ask the agent something; the answer shows the whole pool.
    pool = {"type": "recruiting", "view": "pool", "roleId": a}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is everyone.", [pool], conversation_id="cA"))
    page.click("#message-input")
    page.keyboard.type("who else is there?")
    page.keyboard.press("Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Here is everyone.')")
    page.wait_for_timeout(800)
    old = page.query_selector_all(".chat-block")[0]
    reopen = old.query_selector(".chat-block-reopen")
    if reopen:
        reopen.click()
        page.wait_for_timeout(300)
    frame = old.query_selector("iframe").content_frame()
    value = alice_reason(frame)
    r.check(value == TYPED, f"Alice's reason is still there when her drawer is opened again (reopened: {bool(reopen)}, reason: {value!r})")
r.finish(console, allow_console=True)

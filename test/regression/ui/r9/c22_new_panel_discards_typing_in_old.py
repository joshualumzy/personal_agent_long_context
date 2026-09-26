"""Only the newest hiring panel stays live: mountPanel folds every other live panel into a "Show this panel"
button, which destroys its iframe. It does so even when the founder is typing in that panel. Answers take a
while, so the founder asks a question and works in the current panel meanwhile (a pass reason, a draft email);
when the answer brings its own panel, the old frame is thrown away with everything unsaved in it, and
reopening it starts empty. The chat stream is scripted in the page; the panels read the seeded server."""
import _setup  # noqa: F401
from common import *
from chatfake import event, turn
from _chatfake4 import INIT

r = Result("c22 a new panel throws away what the founder is typing in the current one")
a = "rolea"
alice = state(a)["candidates"][0]
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
    # A second question whose answer shows the whole pool; it is held while the founder types in Alice's panel.
    pool = {"type": "recruiting", "view": "pool", "roleId": a}
    page.evaluate("chunks => window.__chatScripts.push(chunks)",
                  [event("status", {"phrase": "Thinking"}), "HOLD:a"] + turn("Here is everyone.", [pool], conversation_id="cA"))
    page.fill("#message-input", "who else is there?")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 2")
    reason.focus()
    page.keyboard.type("too junior for this role")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Here is everyone.')")
    page.wait_for_timeout(500)
    frames = page.query_selector_all(".chat-block iframe")
    typed = []
    for f in frames:
        content = f.content_frame()
        if content:
            typed += content.eval_on_selector_all("input, textarea", "els => els.map(e => e.value)")
    r.check(len(frames) >= 1, f"control: the new answer's panel is on screen ({len(frames)} frames)")
    r.check(any("too junior for this role" in v for v in typed),
            f"the unsaved pass reason is still somewhere on screen (values in live frames: {typed})")
r.finish(console, allow_console=True)

"""Round 10's composer-focus rule treats ANY focus inside a hiring panel (activeElement is the IFRAME) as
"typing in a panel" and leaves focus there when an answer lands. The panel is same-origin, and most of what
the founder does in it is clicking: a candidate on the orbit, Keep, Pass. The flow the rounds built for:
ask a question, and while the agent searches, click a candidate in the earlier answer's panel to look at them.
When the answer lands the composer stays unfocused (focus sits on the orbit node inside the frame), so the
follow-up the founder types goes nowhere, the same harm round 10 fixed for the sidebar (c25). Typing in a
text box inside the panel must still keep focus there; this check only clicks. The chat and conversation
API are scripted in the page; the panel is the real seeded recruiting page."""
import _setup  # noqa: F401
from common import *
from chatfake import event, turn
from _chatfake4 import INIT

r = Result("c28 clicking a candidate in a panel while waiting leaves the composer without focus when the answer lands")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("chunks => window.__chatScripts.push(chunks)",
                  turn("Here is the pool.", blocks=[{"type": "recruiting", "view": "pool", "roleId": "rolea"}], conversation_id="cA"))
    page.fill("#message-input", "show me the pool")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('.chat-block.live iframe')")
    frame = page.query_selector(".chat-block.live iframe").content_frame()
    wait_board(frame)
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("status", {"phrase": "Searching for candidates"}), "HOLD:a",
        event("done", {"answer": "Found three more.", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "find more like the first one")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 2")
    frame.click("#nodes .node")
    page.wait_for_timeout(500)
    inside = frame.evaluate("() => { const a = document.activeElement; return a ? `${a.tagName}.${a.className}` : null; }")
    typing_inside = frame.evaluate("""() => { const a = document.activeElement;
      return !!a && (a.tagName === 'TEXTAREA' || a.isContentEditable || (a.tagName === 'INPUT' && !['button','submit','checkbox','radio'].includes(a.type))); }""")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Found three more.')")
    page.wait_for_timeout(200)
    page.keyboard.type("only Singapore please")
    page.wait_for_timeout(200)
    composer = page.input_value("#message-input")
    r.check(not typing_inside, f"control: the click left focus on a non-text element in the panel ({inside})")
    r.check(composer == "only Singapore please",
            f"the follow-up typed after the answer lands goes into the composer (composer {composer!r}, panel focus was {inside})")
r.finish(console, allow_console=True)

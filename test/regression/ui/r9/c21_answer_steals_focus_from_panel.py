"""When an answer ends, the chat's `finally` calls messageInput.focus() unconditionally. Answers take from
seconds to minutes, and the chat invites the founder to work in the live hiring panel meanwhile (the composer
is locked anyway). A founder typing a pass reason or editing a draft email in the panel has focus yanked into
the composer the moment the answer lands: the rest of the sentence goes into the chat box, and the next Enter
sends it to the agent as a question. The chat stream is scripted in the page; the panel reads the seeded server."""
import _setup  # noqa: F401
from common import *
from chatfake import event, turn
from _chatfake4 import INIT

r = Result("c21 an answer landing pulls focus out of the hiring panel the founder is typing in")
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
    frame = page.frame_locator(".chat-block.live iframe")
    reason = frame.locator("#drawer input[placeholder^='Why?']")
    reason.wait_for(timeout=15000)
    # A second question; its answer is held while the founder works in the panel.
    page.evaluate("chunks => window.__chatScripts.push(chunks)",
                  [event("status", {"phrase": "Thinking"}), "HOLD:a"] + turn("Bob looks good too.", conversation_id="cA"))
    page.fill("#message-input", "how about bob?")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 2")
    reason.focus()  # the founder scrolled up to the panel and clicked into the box
    page.keyboard.type("too junior")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Bob looks good too.')")
    page.wait_for_timeout(200)
    page.keyboard.type(" for this role")  # the founder is still typing the reason
    page.wait_for_timeout(200)
    reason_value = reason.input_value()
    composer = page.input_value("#message-input")
    r.check("too junior" in reason_value, f"control: the text typed before the answer landed is in the pass reason ({reason_value!r})")
    r.check(reason_value == "too junior for this role" and composer == "",
            f"every key lands in the pass reason (reason {reason_value!r}, chat composer {composer!r})")
r.finish(console, allow_console=True)

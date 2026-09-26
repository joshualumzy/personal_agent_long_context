"""Round 9 stopped a finished answer from pulling focus out of a panel the founder types in: the chat's
`finally` now focuses the composer only when nothing else holds focus (document.body) or the composer does.
But the founder commonly holds focus on a plain button, not a text box: the flow rounds 5 to 9 built for is
"ask in Chat A, look at Chat B, click Chat A again in the sidebar". That click leaves focus on Chat A's sidebar
button, so when the answer lands the `finally` skips the composer (the "New chat" button pressed while waiting
does the same). The answer's own loadConversations() then redraws the sidebar, dropping focus to the page, and
the founder's follow-up keys go nowhere. Before round 9 the composer always got focus back. The chat and conversation API are scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c25 an answer landing after returning through the sidebar leaves the composer without focus")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cA', title: 'Chat A', updatedAt: now },
        { conversationId: 'cB', title: 'Chat B', updatedAt: now } ];
      window.__details.cA = { messages: [{ role: 'user', content: 'old question A' }, { role: 'assistant', content: 'old answer A' }] };
      window.__details.cB = { messages: [{ role: 'user', content: 'question B' }, { role: 'assistant', content: 'answer B' }] };
    }""")
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('old answer A')")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("status", {"phrase": "Searching for candidates"}), "HOLD:a",
        event("done", {"answer": "Found three people.", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "find me backend engineers")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer B')")
    page.evaluate("() => { window.__details.cA.messages.push({ role: 'user', content: 'find me backend engineers' }); }")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('find me backend engineers')")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Found three people.')")
    page.wait_for_timeout(200)
    focused = page.evaluate("() => { const a = document.activeElement; return a ? `${a.tagName}.${a.className}` : null; }")
    page.keyboard.type("only Singapore please")
    page.wait_for_timeout(200)
    composer = page.input_value("#message-input")
    r.check("Found three people." in page.inner_text("#chat-messages"), "control: the answer is drawn in Chat A")
    r.check(composer == "only Singapore please",
            f"the follow-up typed after the answer lands goes into the composer (composer {composer!r}, focus on {focused})")
r.finish(console, allow_console=True)

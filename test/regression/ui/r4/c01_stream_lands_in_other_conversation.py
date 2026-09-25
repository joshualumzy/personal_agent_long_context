"""Switching to another conversation (or 'New chat') while an answer is still streaming: the final 'done'
event still sets activeConversationId to the streaming conversation, so the next message typed in the
conversation on screen is sent to (and saved in) the other one. The stream and the conversation API
are scripted in the page."""
import _setup  # noqa: F401
import json
from common import *
from chatfake import event
from _chatfake2 import INIT

r = Result("c01 a finishing stream hijacks the conversation switched to")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      window.__conversations = [{ conversationId: 'c-other', title: 'Other chat', updatedAt: new Date().toISOString() }];
      window.__details['c-other'] = { messages: [
        { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' } ] };
    }""")
    page.evaluate("() => loadConversations()")
    page.wait_for_selector(".conversation-item")
    chunks = [event("token", {"delta": "STREAMED-NEW "}), "HOLD",
              event("token", {"delta": "tail"}),
              event("done", {"answer": "STREAMED-NEW tail", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "c-new"})]
    page.evaluate("chunks => window.__chatScripts.push(chunks)", chunks)
    page.fill("#message-input", "new question")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('STREAMED-NEW')")
    # the founder opens the other conversation while the answer is still streaming
    page.click(".conversation-item")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('old answer')")
    page.evaluate("() => window.__release()")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled")
    page.wait_for_timeout(300)
    shown = page.text_content("#chat-messages")
    r.check("STREAMED-NEW" not in shown and "tail" not in shown,
            f"the other conversation does not show the streamed answer (view text: {shown.strip()[:120]!r})")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [event("done", {"answer": "ok", "model": "soclaas", "sources": [], "blocks": []})])
    page.fill("#message-input", "follow-up in Other chat")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 2")
    sent_to = page.evaluate("() => window.__chatBodies[1].conversationId")
    r.check(sent_to == "c-other", f"a message typed in 'Other chat' goes to c-other (sent to {sent_to!r})")
r.finish(console, allow_console=True)

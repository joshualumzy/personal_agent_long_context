"""Round 5's failed-history reset clears the messages and sets activeConversationId = null, so the next
message starts a new conversation. But the header still names the conversation that failed (and its
sidebar item stays highlighted). A question typed there goes to a brand-new conversation while the page
keeps saying it is in "Chat X", and the header never corrects itself after the answer arrives.
The conversation API and the stream are scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c13 after a failed history load the header names a conversation the chat is not in")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cA', title: 'Chat A', updatedAt: now },
        { conversationId: 'cX', title: 'Chat X', updatedAt: now } ];
      window.__details.cA = { messages: [{ role: 'user', content: 'question in A' }, { role: 'assistant', content: 'ANSWER IN A' }] };
      window.__detailStatus.cX = 500;
    }""")
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('ANSWER IN A')")
    page.click(".conversation-item[data-conversation-id='cX']")
    page.wait_for_selector(".error-bubble")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("done", {"answer": "ok", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cNew"})])
    page.fill("#message-input", "follow-up")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1 && !document.querySelector('#message-input').disabled")
    page.wait_for_timeout(200)
    sent_to = page.evaluate("() => window.__chatBodies[0].conversationId || null")
    title = page.text_content("#current-chat-title").strip()
    active = page.evaluate("() => [...document.querySelectorAll('.conversation-item.active')].map((el) => el.dataset.conversationId)")
    r.check(sent_to == "cX" or (title != "Chat X" and "cX" not in active),
            f"the conversation the page says it is in is the one the message went to (header {title!r}, highlighted {active}, sent to {sent_to!r})")
r.finish(console, allow_console=True)

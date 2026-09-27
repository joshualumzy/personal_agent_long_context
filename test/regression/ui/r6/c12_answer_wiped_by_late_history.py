"""The other half of the round 5 "answer on return" fix. The founder returns to conversation A while its
answer is still streaming; A's history request was answered before the answer was saved but reaches the
page after `done`. On `done` the page appends the answer (activeConversationId is already A), then the
late history clears the view and redraws it without the answer: the founder sees their question
unanswered. The stream and conversation API are scripted in the page (the history is held, then released)."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c12 the answer drawn on return is wiped by the history that was loading")
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
        event("token", {"delta": "PARTIAL "}), "HOLD:a",
        event("done", {"answer": "FINAL ANSWER FOR A", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "new question A")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('PARTIAL')")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer B')")
    # A's history as read before the answer was saved; its response is slow to arrive.
    page.evaluate("""() => {
      window.__details.cA = JSON.parse(JSON.stringify(window.__details.cA));
      window.__details.cA.messages.push({ role: 'user', content: 'new question A' });
      window.__detailHold.cA = 'h';
    }""")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#current-chat-title').textContent === 'Chat A'")
    # The server now saves the answer and writes `done`.
    page.evaluate("() => { window.__detailHold.cA = null; window.__details.cA.messages.push({ role: 'assistant', content: 'FINAL ANSWER FOR A' }); }")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.evaluate("() => window.__release('h')")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('new question A')")
    page.wait_for_timeout(300)
    title = page.text_content("#current-chat-title").strip()
    shown = page.text_content("#chat-messages")
    r.check(title == "Chat A", f"control: Chat A is on screen ({title!r})")
    r.check("FINAL ANSWER FOR A" in shown,
            f"Chat A, on screen when its answer finished, still shows that answer (view: {shown.strip()[-120:]!r})")
r.finish(console, allow_console=True)

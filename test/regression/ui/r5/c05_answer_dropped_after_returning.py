"""An answer is streaming in conversation A; the founder peeks at conversation B and comes back to A before
the answer ends. A's history was loaded before the answer was saved, and the stream is ignored because the
chatEpoch guard compares "how many switches happened", not "which conversation is on screen". When the
stream ends, A is on screen but its answer is never drawn (only the sidebar reloads); the founder sees
their question unanswered until they reopen the chat. The stream and conversation API are scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake3 import INIT

r = Result("c05 answer for the conversation on screen is dropped after switching away and back")
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
    # A's history now holds the new question, not yet the answer (it is saved when the turn ends)
    page.evaluate("""() => { window.__details.cA.messages.push({ role: 'user', content: 'new question A' }); }""")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('new question A')")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled")
    page.wait_for_timeout(300)
    shown = page.text_content("#chat-messages")
    title = page.text_content("#current-chat-title")
    r.check(title.strip() == "Chat A", f"control: Chat A is on screen ({title!r})")
    r.check("FINAL ANSWER FOR A" in shown,
            f"Chat A, on screen when its answer finished, shows that answer (view: {shown.strip()[-120:]!r})")
r.finish(console, allow_console=True)

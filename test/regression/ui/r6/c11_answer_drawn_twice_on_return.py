"""Round 5 draws an answer when its conversation is back on screen (app.js, the `!stillHere()` branch after
the stream loop). It appends finalPayload without asking whether the history just loaded already holds it.
The server saves the answer before it writes the `done` event, so when the founder returns to A after the
save but before the page has read `done`, A's history already shows the answer and the page then appends it
again: the same answer twice. The stream and conversation API are scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c11 an answer is drawn twice after returning to its conversation")
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
    # The server has saved the answer (it does so before writing `done`); the page has not read `done` yet.
    page.evaluate("""() => { window.__details.cA.messages.push(
        { role: 'user', content: 'new question A' }, { role: 'assistant', content: 'FINAL ANSWER FOR A' }); }""")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('FINAL ANSWER FOR A')")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.wait_for_function("() => true")
    page.wait_for_timeout(300)
    title = page.text_content("#current-chat-title").strip()
    count = page.evaluate("""() => [...document.querySelectorAll('#chat-messages .message-row.assistant')]
        .filter((row) => row.textContent.includes('FINAL ANSWER FOR A')).length""")
    r.check(title == "Chat A", f"control: Chat A is on screen ({title!r})")
    r.check(count == 1, f"Chat A shows its new answer once (shown {count} times)")
r.finish(console, allow_console=True)

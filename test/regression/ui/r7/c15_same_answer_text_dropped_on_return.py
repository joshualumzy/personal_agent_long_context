"""Round 5/6 draw an answer that finishes for a conversation the founder left and came back to, unless
drawnLastAnswer says that exact text was already drawn from the history. The check compares text only: if the
new answer reads the same as the previous one in that conversation (a repeated "Insufficient evidence", a
greeting), the history loaded before the answer was saved is taken as already showing it, and the founder sees
the new question unanswered. The chat and conversation API are scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

SAME = "Insufficient evidence to answer that."
r = Result("c15 a new answer with the same text as the last one is not drawn on return")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""same => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cA', title: 'Chat A', updatedAt: now },
        { conversationId: 'cB', title: 'Chat B', updatedAt: now } ];
      window.__details.cA = { messages: [{ role: 'user', content: 'first question' }, { role: 'assistant', content: same }] };
      window.__details.cB = { messages: [{ role: 'user', content: 'question B' }, { role: 'assistant', content: 'answer B' }] };
    }""", SAME)
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('first question')")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("token", {"delta": "Insufficient "}), "HOLD:a",
        event("done", {"answer": SAME, "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "second question")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer B')")
    # Back to A; its history is read before the new answer is saved.
    page.evaluate("() => { window.__details.cA.messages.push({ role: 'user', content: 'second question' }); }")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('second question')")
    page.evaluate("same => { window.__details.cA.messages.push({ role: 'assistant', content: same }); window.__release('a'); }", SAME)
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.wait_for_timeout(300)
    texts = page.eval_on_selector_all("#chat-messages .message-row", "rows => rows.map(r => r.innerText.trim())")
    after = texts[texts.index(next(t for t in texts if "second question" in t)) + 1:] if any("second question" in t for t in texts) else []
    r.check(any(SAME in t for t in after), f"the second question's answer is shown under it (rows: {[t[:40] for t in texts]})")
r.finish(console, allow_console=True)

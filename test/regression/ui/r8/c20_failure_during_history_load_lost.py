"""Round 7 reports a failed answer once the founder is back in its conversation, but only if the failure
arrives after that conversation's history has loaded (`backInIt` needs `!historyLoading`). Unlike a finished
answer, which is parked in finishedAnswers and drawn by the history load, a failure that lands while the
history is on its way is dropped. The founder asks in A, looks at B, comes back to A; the agent fails during
the (slow) history load; the history shows the question with nothing under it and no error. The chat and
conversation API are scripted in the page; the history is held while the error arrives."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c20 a failure that arrives while its conversation's history reloads is never reported")
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
        event("status", {"phrase": "Thinking"}), "HOLD:a",
        event("error", {"message": "The model is unavailable right now."})])
    page.fill("#message-input", "new question A")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer B')")
    # The question was saved when it was asked; the history read now holds it, but arrives late.
    page.evaluate("() => { window.__details.cA.messages.push({ role: 'user', content: 'new question A' }); window.__detailHold.cA = 'h'; }")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#current-chat-title').textContent === 'Chat A'")
    page.evaluate("() => window.__release('a')")  # the agent fails while A's history is on its way
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.evaluate("() => window.__release('h')")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('new question A')")
    page.wait_for_timeout(300)
    rows = page.eval_on_selector_all("#chat-messages .message-row", "rows => rows.map(r => r.innerText.trim())")
    r.check(any("new question A" in t for t in rows), f"control: Chat A with the new question is on screen ({[t[:30] for t in rows]})")
    idx = [i for i, t in enumerate(rows) if "new question A" in t]
    after = rows[idx[-1] + 1:] if idx else []
    r.check(bool(after), f"something under the new question says it failed (rows after it: {after})")
r.finish(console, allow_console=True)

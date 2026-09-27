"""Round 7 reports a failed answer after the founder leaves conversation A and comes back, but only an
`error` event. A stream that is cut before its `done` (a proxy timeout, a server restart) while the founder is
away takes the `!stillHere()` branch, which returns quietly: no "cut off" message. Back in A, the founder sees
their question with nothing under it, the composer unlocked, and no sign the answer will never come. When the
founder never leaves, the same cut says "The answer was cut off". The chat and conversation API are scripted
in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c19 a stream cut before its end is not reported after returning to its conversation")
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
        event("token", {"delta": "Partial"})])
    page.fill("#message-input", "new question A")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer B')")
    page.evaluate("() => { window.__details.cA.messages.push({ role: 'user', content: 'new question A' }); }")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('new question A')")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.wait_for_timeout(300)
    rows = page.eval_on_selector_all("#chat-messages .message-row", "rows => rows.map(r => r.innerText.trim())")
    r.check(rows and "new question A" in rows[-2 if len(rows) > 1 else -1] + rows[-1], f"control: Chat A with the new question is on screen ({[t[:30] for t in rows]})")
    after = rows[[i for i, t in enumerate(rows) if "new question A" in t][-1] + 1:]
    r.check(bool(after), f"something under the new question says it failed (rows after it: {after})")
r.finish(console, allow_console=True)

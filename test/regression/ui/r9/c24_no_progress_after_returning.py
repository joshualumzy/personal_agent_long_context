"""An answer keeps streaming when the founder looks at another conversation, and rounds 5 to 8 draw it (or its
failure) once they are back. But opening a conversation ends with `statusIndicator.hidden = true`, and the
stream's status events are not drawn while `!stillHere()`. So back in the asking conversation the founder sees
their question, a locked composer, and no sign anything is still happening, for as long as the answer takes
(often minutes): it looks stuck, and the natural move is to reload, which loses the answer's live panel and
leaves nothing to show it ever came. The chat and conversation API are scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c24 back in a conversation whose answer is still coming, nothing shows it is being worked on")
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
        event("status", {"phrase": "Searching for candidates"}), "HOLD:a", event("status", {"phrase": "Scoring"}), "HOLD:b",
        event("done", {"answer": "Found three people.", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "find me backend engineers")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    visible_while_asking = page.evaluate("() => !document.querySelector('#status-indicator').hidden")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer B')")
    page.evaluate("() => { window.__details.cA.messages.push({ role: 'user', content: 'find me backend engineers' }); }")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('find me backend engineers')")
    page.evaluate("() => window.__release('a')")  # the agent is still working
    page.wait_for_timeout(600)
    busy = page.evaluate("() => document.querySelector('#message-input').disabled")
    shown = page.evaluate("() => !document.querySelector('#status-indicator').hidden && document.querySelector('#status-text').textContent")
    r.check(visible_while_asking, "control: a progress line shows while the question is asked")
    r.check(busy, "control: back in Chat A, the answer is still on its way (composer locked)")
    rows = page.eval_on_selector_all("#chat-messages .message-row", "rows => rows.map(r => r.innerText.trim())")
    below = rows[[i for i, t in enumerate(rows) if "find me backend engineers" in t][-1] + 1:]
    r.check(bool(shown) or any(below),
            f"back in Chat A, something shows the answer is still being worked on (status line: {shown!r}, rows under the question: {below})")
    page.evaluate("() => window.__release('b')")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Found three people.')")
r.finish(console, allow_console=True)

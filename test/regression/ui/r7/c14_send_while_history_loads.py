"""The founder opens conversation A and, while its history is still loading, asks a question (the composer
is not locked during the load). The question goes to A and its answer streams in; then A's history arrives
and selectConversation clears the view and redraws the history. The new question and the answer being
streamed are wiped: the answer finishes into a detached bubble and never appears. The chat and conversation
API are scripted in the page; the history is held and released after the send."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c14 an answer asked for while the history loads is wiped by that history")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [{ conversationId: 'cA', title: 'Chat A', updatedAt: now }];
      window.__details.cA = { messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }] };
      window.__detailHold.cA = 'h';
    }""")
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#current-chat-title').textContent === 'Chat A'")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("token", {"delta": "NEW "}), "HOLD:a",
        event("done", {"answer": "NEW ANSWER", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "new question")
    page.press("#message-input", "Enter")
    page.wait_for_timeout(500)
    sent = page.evaluate("() => window.__chatBodies.length")
    if sent:  # (a composer locked while the history loads would also remove the harm)
        page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('NEW')")
        r.check(page.evaluate("() => window.__chatBodies[0]?.conversationId") == "cA", "control: the question went to Chat A")
    page.evaluate("() => window.__release('h')")  # the history (read before the question) arrives
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('old answer')")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.wait_for_timeout(300)
    shown = page.text_content("#chat-messages")
    if not sent:
        print("  (no question was sent while the history loaded)")
    else:
      r.check("new question" in shown, f"the question just asked is still on screen (view: {shown.strip()[-120:]!r})")
      r.check("NEW ANSWER" in shown, f"its answer is on screen once it finishes (view: {shown.strip()[-120:]!r})")
r.finish(console, allow_console=True)

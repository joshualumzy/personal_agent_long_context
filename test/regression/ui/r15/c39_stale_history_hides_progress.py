"""Round 9 made a conversation with an answer on its way show progress once the founder is back in it. But
every history load ends with `statusIndicator.hidden = !answering`, and `answering` needs `asked === chatEpoch`.
A load that was overtaken (the founder clicked Chat B, then went back to Chat A before B's history arrived)
still runs that line when B finally answers: it hides the "Still working on your question…" line that A's own,
newer load has just shown. Back in Chat A the founder sees their question, a locked composer and nothing else
for as long as the answer takes. The chat and conversation API are scripted in the page; B's history is held.
Passes if, after B's late history arrives, Chat A still shows that its answer is being worked on."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c39 a late history load for a conversation already left hides the progress line")
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
        event("status", {"phrase": "Searching for candidates"}), "HOLD:answer",
        event("done", {"answer": "Found three people.", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "find me backend engineers")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    page.evaluate("() => { window.__details.cA.messages.push({ role: 'user', content: 'find me backend engineers' }); window.__detailHold.cB = 'b'; }")
    # Chat B's history is slow; the founder goes back to Chat A before it arrives.
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_timeout(200)
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('find me backend engineers')")
    page.wait_for_timeout(200)
    before = page.evaluate("() => !document.querySelector('#status-indicator').hidden")
    r.check(before, "control: back in Chat A, the progress line shows before B's late history arrives")
    page.evaluate("() => window.__release('b')")
    page.wait_for_timeout(500)
    busy = page.evaluate("() => document.querySelector('#message-input').disabled")
    title = page.inner_text("#current-chat-title")
    shown = page.evaluate("() => !document.querySelector('#status-indicator').hidden && document.querySelector('#status-text').textContent")
    r.check(busy and title == "Chat A", f"control: Chat A is on screen and its answer is still on its way (title {title!r}, composer locked: {busy})")
    r.check(bool(shown), f"Chat A still shows its answer is being worked on after B's late history arrived (status line: {shown!r})")
    page.evaluate("() => window.__release('answer')")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Found three people.')")
r.finish(console, allow_console=True)

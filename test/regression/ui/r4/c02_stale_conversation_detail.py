"""Opening conversation A and then B before A's history arrived: A's late answer replaces the view, so the
page shows A's messages under B's title, with B highlighted and B as the conversation the next message
goes to. The conversation API is scripted in the page; A's detail is held until B has loaded."""
import _setup  # noqa: F401
from common import *
from _chatfake2 import INIT

r = Result("c02 late history of the previous conversation overwrites the one opened")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cA', title: 'Chat A', updatedAt: now },
        { conversationId: 'cB', title: 'Chat B', updatedAt: now } ];
      window.__details.cA = { messages: [{ role: 'user', content: 'question from A' }, { role: 'assistant', content: 'answer in A' }] };
      window.__details.cB = { messages: [{ role: 'user', content: 'question from B' }, { role: 'assistant', content: 'answer in B' }] };
      window.__detailGates.cA = true;
    }""")
    page.evaluate("() => loadConversations()")
    page.wait_for_selector(".conversation-item[data-conversation-id='cB']")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer in B')")
    page.evaluate("() => window.__openGate('cA')")  # A's slow answer arrives now
    page.wait_for_timeout(500)
    shown = page.text_content("#chat-messages")
    title = page.text_content("#current-chat-title")
    r.check("answer in A" not in shown and "answer in B" in shown,
            f"view under title {title!r} shows B's history, not A's (view: {shown.strip()[:80]!r})")
r.finish(console, allow_console=True)

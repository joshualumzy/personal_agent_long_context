"""Opening conversation B whose history fails to load (server error, or B was deleted in another tab):
selectConversation already switched activeConversationId and the title to B, but leaves A's messages on
screen and only appends an error. The founder sees A's thread under B's title and a follow-up typed there
is sent to B, not to the conversation whose messages are shown. The conversation API is scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake3 import INIT

r = Result("c07 a failed history load leaves the previous conversation on screen")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cA', title: 'Chat A', updatedAt: now },
        { conversationId: 'cB', title: 'Chat B', updatedAt: now } ];
      window.__details.cA = { messages: [{ role: 'user', content: 'question in A' }, { role: 'assistant', content: 'ANSWER IN A' }] };
      window.__detailStatus.cB = 500;
    }""")
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('ANSWER IN A')")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_selector(".error-bubble")
    page.wait_for_timeout(200)
    shown = page.text_content("#chat-messages")
    title = page.text_content("#current-chat-title").strip()
    a_shown = "ANSWER IN A" in shown
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [event("done", {"answer": "ok", "model": "soclaas", "sources": [], "blocks": []})])
    page.fill("#message-input", "follow-up")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    sent_to = page.evaluate("() => window.__chatBodies[0].conversationId")
    shown_conv = "cA" if a_shown else None
    r.check(not a_shown or sent_to == "cA",
            f"the follow-up goes to the conversation whose messages are on screen (screen: A's thread under title {title!r}; sent to {sent_to!r})")
r.finish(console, allow_console=True)

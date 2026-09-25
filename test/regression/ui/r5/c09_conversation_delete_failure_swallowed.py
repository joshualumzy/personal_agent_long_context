"""deleteConversation() never looks at the response status: when the server refuses or fails the DELETE
(500), the open conversation is cleared from the screen as if it were deleted and no error is shown; the
sidebar still lists it. The founder believes a chat is gone that is still stored. The conversation API is
scripted in the page (DELETE answers 500)."""
import _setup  # noqa: F401
from common import *
from _chatfake3 import INIT

r = Result("c09 a failed conversation delete looks like it worked")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.add_init_script("window.__alerts = []; window.confirm = () => true; window.alert = (m) => window.__alerts.push(String(m));")
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      window.__conversations = [{ conversationId: 'cA', title: 'Chat A', updatedAt: new Date().toISOString() }];
      window.__details.cA = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'ANSWER IN A' }] };
      window.__deleteStatus = 500;
    }""")
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('ANSWER IN A')")
    page.hover(".conversation-item[data-conversation-id='cA']")
    page.click(".conversation-item[data-conversation-id='cA'] .conv-delete-btn", force=True)
    page.wait_for_function("() => window.__deletes.length === 1")
    page.wait_for_timeout(400)
    still_listed = page.locator(".conversation-item[data-conversation-id='cA']").count() == 1
    shown = page.text_content("#chat-messages")
    dialogs = page.evaluate("() => window.__alerts")
    told = bool(dialogs) or page.locator(".error-bubble").count() > 0
    r.check(bool(told) or "ANSWER IN A" in shown,
            f"after a failed delete the founder is told, or still sees the chat (listed: {still_listed}; view: {shown.strip()[:60]!r}; messages: {dialogs})")
r.finish(console, allow_console=True)

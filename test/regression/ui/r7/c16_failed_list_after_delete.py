"""deleteConversation() removes nothing itself: it relies on loadConversations(), which returns silently when
the list request fails. The server deletes the conversation, the list reload answers 500, and the deleted
conversation stays in the sidebar with no word that anything went wrong; opening it then fails. The
conversation API is scripted in the page."""
import _setup  # noqa: F401
from common import *
from _chatfake4 import INIT

FAIL_LIST = r"""
(() => {
  const inner = window.fetch;
  window.__failLists = false;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init && init.method) || 'GET';
    if (method === 'GET' && /\/api\/v1\/conversations\?/.test(url) && window.__failLists)
      return new Response('{"message":"database unavailable"}', { status: 500, headers: { 'content-type': 'application/json' } });
    return inner(input, init);
  };
})();
"""
r = Result("c16 a deleted conversation stays listed when the list reload fails")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.add_init_script(FAIL_LIST)
    page.add_init_script("window.confirm = () => true;")
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cOld', title: 'Old chat', updatedAt: now },
        { conversationId: 'cKeep', title: 'Kept chat', updatedAt: now } ];
    }""")
    page.evaluate("() => loadConversations()")
    page.wait_for_selector(".conversation-item[data-conversation-id='cOld']")
    page.evaluate("() => { window.__failLists = true; }")
    page.hover(".conversation-item[data-conversation-id='cOld']")
    page.click(".conversation-item[data-conversation-id='cOld'] .conv-delete-btn", force=True)
    page.wait_for_function("() => window.__deletes.length === 1")
    page.wait_for_timeout(400)
    r.check(page.evaluate("() => !window.__conversations.some(c => c.conversationId === 'cOld')"), "control: the server deleted it")
    listed = page.locator(".conversation-item[data-conversation-id='cOld']").count()
    notice = page.locator(".error-bubble, .conversations-error, [role=alert]").count()
    r.check(listed == 0 or notice > 0,
            f"the deleted conversation is no longer offered in the sidebar, or the page says the list could not be refreshed (still listed: {bool(listed)}, notices: {notice})")
r.finish(console, allow_console=True)

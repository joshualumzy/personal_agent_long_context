"""loadConversations() paints whichever list answers last. A list requested when an answer finished (slow)
lands after the list requested by a delete, so the deleted conversation comes back in the sidebar; opening
it fails. The conversation API is scripted in the page; the first list request is held until the delete's
list has been drawn."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake3 import INIT

GATE = r"""
(() => {
  const inner = window.fetch;
  let first = true;
  window.__listGate = null;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init && init.method) || 'GET';
    if (method === 'GET' && /\/api\/v1\/conversations\?/.test(url) && window.__holdNextList) {
      window.__holdNextList = false;
      const snapshot = JSON.stringify(window.__conversations);  // what the server had when asked
      await new Promise((resolve) => { window.__listGate = resolve; });
      return new Response(snapshot, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return inner(input, init);
  };
})();
"""
r = Result("c10 a slow conversation list brings a deleted conversation back")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.add_init_script(GATE)
    page.add_init_script("window.confirm = () => true;")
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cOld', title: 'Old chat', updatedAt: now },
        { conversationId: 'cNew', title: 'New chat', updatedAt: now } ];
    }""")
    page.evaluate("() => loadConversations()")
    page.wait_for_selector(".conversation-item[data-conversation-id='cOld']")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("done", {"answer": "hello", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cNew"})])
    page.evaluate("() => { window.__holdNextList = true; }")
    page.fill("#message-input", "hi")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__listGate !== null")  # the list after the answer is slow
    page.hover(".conversation-item[data-conversation-id='cOld']")
    page.click(".conversation-item[data-conversation-id='cOld'] .conv-delete-btn", force=True)
    page.wait_for_function("() => !document.querySelector(\".conversation-item[data-conversation-id='cOld']\")")
    page.evaluate("() => window.__listGate()")
    page.wait_for_timeout(400)
    back = page.locator(".conversation-item[data-conversation-id='cOld']").count()
    r.check(back == 0, f"the deleted conversation stays out of the sidebar (listed again: {bool(back)})")
r.finish(console, allow_console=True)

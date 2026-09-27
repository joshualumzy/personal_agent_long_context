"""setAnswerHtml() turns [source:ID] into a citation button in every text node, including the text of a link
("see [the handbook [source:doc-1]](https://...)"). The button then sits inside the <a>: pressing the
citation to read the source also follows the link, so the chat page is replaced by the linked page (and an
answer still streaming is lost). The chat and the source API are scripted in the page; the link target is
answered by the test."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

SOURCE = r"""
(() => {
  const inner = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v1/company/sources/'))
      return new Response(JSON.stringify({ sourceId: 'doc-1', sourceType: 'document', title: 'Handbook', excerpt: 'Leave is 14 days.' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    return inner(input, init);
  };
})();
"""
ANSWER = "Leave is 14 days, see [the handbook [source:doc-1]](https://handbook.example.com/leave)."
r = Result("c17 pressing a citation inside a link leaves the chat")
with browser_page(1440, 900) as (page, console):
    page.route("https://handbook.example.com/**", lambda route: route.fulfill(status=200, content_type="text/html", body="<h1>Handbook site</h1>"))
    page.add_init_script(INIT)
    page.add_init_script(SOURCE)
    page.goto(f"{BASE}/")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("token", {"delta": ANSWER}),
        event("done", {"answer": ANSWER, "model": "soclaas", "sources": [], "blocks": [], "conversationId": "cA"})])
    page.fill("#message-input", "how much leave?")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.wait_for_timeout(300)
    inside = page.evaluate("() => Boolean(document.querySelector('#chat-messages a .inline-citation'))")
    r.check("Leave is 14 days" in page.text_content("#chat-messages"), "control: the answer is drawn")
    if page.locator("#chat-messages .inline-citation").count():
        page.click("#chat-messages .inline-citation")
        page.wait_for_timeout(800)
    url = page.url
    r.check(url.startswith(BASE), f"the chat page is still open after pressing the citation (now at {url}; citation inside a link: {inside})")
r.finish(console, allow_console=True)

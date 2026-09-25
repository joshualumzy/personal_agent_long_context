"""While an answer streams, the composer is disabled, but 'New chat' shows the suggestion chips and a chip
calls chatForm.requestSubmit() regardless, so a second request starts while the first is in flight. When the
first (now off-screen) stream ends, its finally re-enables the composer although the chip's answer is still
streaming on screen. A message typed then is sent without a conversation id (the chip's id arrives only with
its 'done'), so it opens yet another conversation instead of continuing the one on screen.
The streams and conversation API are scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake3 import INIT

r = Result("c06 a suggestion chip starts a second request while one is streaming")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("token", {"delta": "FIRST "}), "HOLD:one",
        event("done", {"answer": "FIRST done", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "c1"})])
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("token", {"delta": "CHIP "}), "HOLD:two",
        event("done", {"answer": "CHIP done", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "c2"})])
    page.fill("#message-input", "first question")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('FIRST')")
    page.click("#new-chat-btn")
    page.locator(".chip").first.click()
    page.wait_for_timeout(300)
    in_flight = page.evaluate("() => window.__chatBodies.length")
    page.evaluate("() => window.__release('one')")  # the first, off-screen answer ends
    page.wait_for_function("() => window.__streamsOpen <= 1")
    page.wait_for_timeout(300)
    enabled = page.evaluate("() => !document.querySelector('#message-input').disabled")
    if enabled:
        page.evaluate("chunks => window.__chatScripts.push(chunks)", [
            event("done", {"answer": "third", "model": "soclaas", "sources": [], "blocks": [], "conversationId": "c3"})])
        page.fill("#message-input", "follow-up to the chip's answer")
        page.press("#message-input", "Enter")
        page.wait_for_function("n => window.__chatBodies.length === n + 1", arg=in_flight)
    page.evaluate("() => window.__release('two')")
    page.wait_for_timeout(500)
    bodies = page.evaluate("() => window.__chatBodies")
    print(f"  info: {in_flight} requests in flight after the chip click; composer enabled mid-stream: {enabled}")
    stray = [b for b in bodies[in_flight:] if in_flight > 1 and b.get("conversationId") != "c2"]
    r.check(not stray, f"no follow-up leaves the conversation on screen while its answer streams (sent: {[(b['message'], b.get('conversationId')) for b in bodies]})")
r.finish(console, allow_console=True)

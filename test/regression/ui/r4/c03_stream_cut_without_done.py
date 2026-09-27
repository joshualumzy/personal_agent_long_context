"""A chat stream that ends without a 'done' or 'error' event (connection dropped by a proxy, server
restart, idle timeout) is treated as success: finalPayload stays null, nothing is shown, the question
sits there unanswered (or a half answer stays, looking complete), and no error tells the user to retry.
The stream is scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake2 import INIT

r = Result("c03 a stream cut before 'done' fails silently")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    # 1. cut before any token
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [event("status", {"phrase": "Thinking"})])
    page.fill("#message-input", "first question")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled")
    page.wait_for_timeout(300)
    errors1 = page.locator(".error-bubble").count()
    r.check(errors1 == 1, f"a stream closed with no answer shows an error (error bubbles: {errors1})")
    # 2. cut in the middle of the answer
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [event("token", {"delta": "The first half of"})])
    page.fill("#message-input", "second question")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled")
    page.wait_for_timeout(300)
    errors2 = page.locator(".error-bubble").count() - errors1
    r.check(errors2 == 1, f"a stream cut mid-answer says the answer is incomplete (new error bubbles: {errors2})")
r.finish(console, allow_console=True)

"""The chat composer sends on Enter (`keydown`, key "Enter", no Shift) without checking `event.isComposing`.
With a Chinese, Japanese or Korean input method, Enter is how a composition is committed: typing "go" in
pinyin mode and pressing Enter should put the letters "go" in the box. Chrome delivers that Enter as a keydown
with key "Enter" and isComposing true, so the composer sends the half-written question to the agent instead
(and the composition is lost). The hiring panel's own box already checks isComposing; the chat composer, the
main way in, does not. The app is built for Chinese-speaking founders too. The chat stream is scripted in
the page; the committing Enter is dispatched as Chrome sends it."""
import _setup  # noqa: F401
from common import *
from chatfake import turn
from _chatfake4 import INIT

r = Result("c27 committing an input-method composition with Enter sends the half-typed question")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("ok", conversation_id="cA"))
    page.fill("#message-input", "帮我找会 go")
    page.focus("#message-input")
    page.evaluate("""() => {
      const box = document.querySelector('#message-input');
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    }""")
    page.wait_for_timeout(500)
    sent = page.evaluate("() => window.__chatBodies.map((b) => b.message)")
    composer = page.input_value("#message-input")
    # Control: a plain Enter afterwards does send (the fake is wired and the composer works).
    page.fill("#message-input", "帮我找会 go 的工程师")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length >= 1")
    after = page.evaluate("() => window.__chatBodies.map((b) => b.message)")
    r.check(after[-1] == "帮我找会 go 的工程师", f"control: a plain Enter sends the question ({after})")
    r.check(sent == [] and composer == "帮我找会 go",
            f"the Enter that commits a composition sends nothing and leaves the text in the box (sent {sent}, composer {composer!r})")
r.finish(console, allow_console=True)

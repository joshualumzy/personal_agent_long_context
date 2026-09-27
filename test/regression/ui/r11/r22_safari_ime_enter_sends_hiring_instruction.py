"""Round 10 taught the chat composer that an Enter carrying keyCode 229 is an input method committing text,
not a send: Safari (WebKit) fires compositionend BEFORE the committing Enter's keydown, so that keydown arrives
with isComposing false and keyCode 229. The hiring panel's box (#say, recruiting.js) still checks isComposing
only. A founder on Safari typing in pinyin "帮我加一条 remote" and pressing Enter to commit "remote" sends the
half-written instruction to the agent, which acts on it (criteria change, feedback). The say and import
requests are answered by the test; the committing Enter is dispatched as Safari sends it."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r22 Safari's IME-committing Enter (keyCode 229, isComposing false) sends the hiring instruction")
a = "rolea"
base = state(a)
posted = []


def on_say(route):
    posted.append(json.loads(route.request.post_data or "{}"))
    route.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"result": {"intent": "criteria", "message": "ok"}, "state": base}))


with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/say", on_say)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.fill("#say", "只要会 remote")
    page.focus("#say")
    seen = page.evaluate("""() => {
      const box = document.querySelector('#say');
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      return { keyCode: ev.keyCode, isComposing: ev.isComposing };
    }""")
    page.wait_for_timeout(600)
    sent = [body.get("text") for body in posted]
    box = page.input_value("#say")
    r.check(seen == {"keyCode": 229, "isComposing": False}, f"control: the event carries keyCode 229 as Safari's does ({seen})")
    # Control: a plain Enter does send.
    page.fill("#say", "只要会 remote 的人")
    page.press("#say", "Enter")
    page.wait_for_function("n => document.querySelector('#say').value === ''", timeout=5000)
    page.wait_for_timeout(200)
    r.check(posted and posted[-1].get("text") == "只要会 remote 的人", f"control: a plain Enter sends ({[b.get('text') for b in posted]})")
    r.check(sent == [] and box == "只要会 remote",
            f"the Enter that commits a composition sends nothing and leaves the text in the box (sent {sent}, box {box!r})")
r.finish(console, allow_console=True)

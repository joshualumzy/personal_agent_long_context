r"""The composer picks pasted LinkedIn links out with /https:\/\/...linkedin\.com\/in\/[^\s,]+/ and round 9
strips sentence punctuation from the end (including "，。）"). But the match itself stops only at ASCII
whitespace or an ASCII comma. Chinese text is written without spaces around a link, and lists use "、" or "，":
"加上 https://www.linkedin.com/in/alice-tan、https://www.linkedin.com/in/bob-lim" is read as ONE link whose slug
is "alice-tan、https:", which the server rejects as "Not a LinkedIn profile link" (neither person is added), and
"请加 https://www.linkedin.com/in/alice-tan，她很合适" sends the slug "alice-tan，她很合适", which the server
accepts and then cannot find. LinkedIn slugs are letters, digits and hyphens (non-Latin ones come
percent-encoded when copied). The import request is answered by the test and records what the page asked for."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r21 a LinkedIn link followed by Chinese text or a Chinese list mark swallows that text")
a = "rolea"
base = state(a)
posted = []


def on_import(route):
    posted.append(json.loads(route.request.post_data or "{}"))
    route.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"result": {"intent": "import", "message": "ok"}, "state": base}))


def sent_for(page, text):
    before = len(posted)
    page.fill("#say", text)
    page.press("#say", "Enter")
    page.wait_for_function("() => !document.querySelector('#say').value", timeout=5000)
    page.wait_for_timeout(300)
    body = posted[before] if len(posted) > before else {}
    return body.get("urls") if isinstance(body.get("urls"), list) else None


with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/candidates/import", on_import)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    listed = sent_for(page, "加上这两位 https://www.linkedin.com/in/alice-tan、https://www.linkedin.com/in/bob-lim")
    trailing = sent_for(page, "请加 https://www.linkedin.com/in/alice-tan，她很合适")
    r.check(listed is not None and trailing is not None, f"control: both messages asked to import links ({posted})")
    want_two = sorted(["https://www.linkedin.com/in/alice-tan", "https://www.linkedin.com/in/bob-lim"])
    got_two = sorted(u.rstrip("/") for u in (listed or []))
    r.check(got_two == want_two, f"two links joined by '、' are sent as the two profiles (sent {listed})")
    got_one = [u.rstrip("/") for u in (trailing or [])]
    r.check(got_one == ["https://www.linkedin.com/in/alice-tan"],
            f"a link followed by '，她很合适' is sent without the Chinese text (sent {trailing})")
r.finish(console)

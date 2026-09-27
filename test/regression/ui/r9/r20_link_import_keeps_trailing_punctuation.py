r"""The composer adds people from pasted LinkedIn links. It picks them out with
/https:\/\/...linkedin\.com\/in\/[^\s,]+/, which stops at a space or comma only, so a link written at the end
of a sentence ("Add https://www.linkedin.com/in/alice-tan.") or in brackets carries the full stop or bracket
into the profile address. The server's own check accepts that slug, and the lookup of "alice-tan." finds no
one: the founder is told the link "could not be read". The import request is answered by the test and records
what the page asked for."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r20 a LinkedIn link at the end of a sentence is imported with its full stop")
a = "rolea"
base = state(a)
posted = []


def on_import(route):
    posted.append(json.loads(route.request.post_data or "{}"))
    route.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"result": {"intent": "import", "message": "ok"}, "state": base}))


with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/candidates/import", on_import)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.fill("#say", "Please add https://www.linkedin.com/in/alice-tan. Also (https://sg.linkedin.com/in/bob-lim) looks good")
    page.press("#say", "Enter")
    page.wait_for_timeout(800)
    urls = posted[0]["urls"] if posted and isinstance(posted[0].get("urls"), list) else None
    r.check(urls is not None, f"control: the page asked to import links ({posted})")
    clean = ["https://www.linkedin.com/in/alice-tan", "https://sg.linkedin.com/in/bob-lim"]
    r.check(urls is not None and sorted(u.rstrip("/") for u in urls) == sorted(clean),
            f"the links sent are the two profiles, without the sentence's punctuation (sent {urls})")
r.finish(console)

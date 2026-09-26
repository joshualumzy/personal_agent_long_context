r"""The hiring box says "paste a LinkedIn link", but the page only recognises links written with "https://":
/https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/.../. LinkedIn itself shows a profile's address without
it (the "Contact info" card and the profile's "Public profile & URL" box read "linkedin.com/in/alice-tan" or
"www.linkedin.com/in/alice-tan"), and founders type it that way. Such a message goes to /say, whose
interpreter knows only criteria, feedback, reply and question: no one is added, and the words may be read as
a criteria change. The server's own canonicalProfileUrl already accepts http:// too. The import and say
requests are answered by the test and record what the page asked for."""
import _setup  # noqa: F401
import json
import re
from common import *

SERVER = re.compile(r"^https://([a-z]{2,3}\.)?(www\.)?linkedin\.com/in/[^/?#\s]+/?$", re.I)
r = Result("r24 a LinkedIn link pasted without https:// is sent to the agent instead of imported")
a = "rolea"
base = state(a)
imported = []
said = []


def answer(store):
    def handler(route):
        store.append(json.loads(route.request.post_data or "{}"))
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps({"result": {"intent": "import", "message": "ok"}, "state": base}))
    return handler


def send(page, text):
    page.fill("#say", text)
    page.press("#say", "Enter")
    page.wait_for_function("() => !document.querySelector('#say').value", timeout=5000)
    page.wait_for_timeout(300)


with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/candidates/import", answer(imported))
    page.route(f"**/api/recruiting/roles/{a}/say", answer(said))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    texts = ["Add https://www.linkedin.com/in/alice-tan",  # control
             "Add linkedin.com/in/bob-lim",
             "Add www.linkedin.com/in/carol-ng/"]
    for text in texts:
        send(page, text)
    flat = [u.rstrip("/").lower() for body in imported for u in (body.get("urls") or [])]
    r.check("https://www.linkedin.com/in/alice-tan" in flat, f"control: an https link is imported ({flat})")
    for slug in ["bob-lim", "carol-ng"]:
        # As the server's import check (service.ts importProfiles) will accept it.
        r.check(any(u.endswith(f"linkedin.com/in/{slug}") and SERVER.match(u) for u in flat),
                f"'{slug}' pasted without https:// is imported, not sent to the agent "
                f"(imported {flat}, sent to the agent {[b.get('text') for b in said]})")
r.finish(console, allow_console=True)

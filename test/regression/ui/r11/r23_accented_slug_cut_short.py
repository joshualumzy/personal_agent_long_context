r"""Round 10 narrowed the composer's LinkedIn pattern to /...linkedin\.com\/in\/[A-Za-z0-9%_-]+\/?/ so Chinese
text after a link is not swallowed. But LinkedIn's own profile addresses carry non-ASCII letters (names are
turned into slugs: "josé-garcía-4a1b2c", "李伟-5b2a1c"), and they reach the founder written out, not
percent-encoded, whenever the link was copied from text (a chat message, a doc, LinkedIn's "Contact info").
The server accepts such a slug and decodes it anyway (canonicalProfileUrl). Now the page cuts the link at the
first accented letter: "https://www.linkedin.com/in/josé-garcía-4a1b2c" is imported as
"https://www.linkedin.com/in/jos", a different (or no) person, and the founder is told who was "added".
A slug that starts with a non-Latin letter matches nothing, so the link is handed to the agent as an
instruction. Before round 10 both were sent whole. The import and say requests are answered by the test."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r23 a LinkedIn link with an accented or Chinese slug is cut short or not imported")
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
    send(page, "Add https://www.linkedin.com/in/alice-tan")  # control
    send(page, "Add https://www.linkedin.com/in/josé-garcía-4a1b2c")
    send(page, "加上 https://www.linkedin.com/in/李伟-5b2a1c")
    urls = [body.get("urls") for body in imported]
    r.check(len(urls) >= 1 and [u.rstrip("/") for u in urls[0]] == ["https://www.linkedin.com/in/alice-tan"],
            f"control: a plain link is imported ({urls})")
    sent_links = [u.rstrip("/") for batch in urls[1:] for u in (batch or [])]
    r.check("https://www.linkedin.com/in/jos" not in sent_links,
            f"no truncated profile 'https://www.linkedin.com/in/jos' is imported (imported {urls[1:]})")
    import urllib.parse as up
    def same(link, slug):
        return up.unquote(link).lower() == f"https://www.linkedin.com/in/{slug}"
    r.check(any(same(u, "josé-garcía-4a1b2c") for u in sent_links),
            f"the accented profile is imported whole (imported {urls[1:]}, said {[b.get('text') for b in said]})")
    r.check(any(same(u, "李伟-5b2a1c") for u in sent_links),
            f"the Chinese-slug profile is imported, not handed to the agent (imported {urls[1:]}, said {[b.get('text') for b in said]})")
r.finish(console, allow_console=True)

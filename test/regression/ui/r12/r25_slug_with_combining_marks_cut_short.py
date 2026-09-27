r"""Round 11 widened the composer's LinkedIn slug to [\p{L}\p{N}%_-] so slugs in any script are imported whole
(r23). But many scripts write names with combining marks, which are \p{M}, not \p{L}: Thai vowel and tone
marks ("ใจดี"), Devanagari vowel signs and virama ("प्रिया", "शर्मा"), and accented Latin in decomposed form
(macOS and some apps copy "José" as "Jose" + U+0301). The link is cut at the first mark:
"https://www.linkedin.com/in/สมชาย-ใจดี-a1b2c3" goes out as ".../in/สมชาย-ใจด", and ".../in/प्रिया-शर्मा-5b2a1c"
as ".../in/प", a different or no person, while the founder is told someone was added.
The server accepts any slug character but / ? # and whitespace. Import and say requests are answered by the test."""
import _setup  # noqa: F401
import json
import unicodedata
import urllib.parse as up
from common import *

r = Result("r25 a LinkedIn slug with combining marks (Thai, Hindi, decomposed accents) is cut short")
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


def norm(link):
    return unicodedata.normalize("NFC", up.unquote(link)).rstrip("/").lower()


SLUGS = ["สมชาย-ใจดี-a1b2c3", "प्रिया-शर्मा-5b2a1c", unicodedata.normalize("NFD", "josé-garcía-4a1b2c")]

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/candidates/import", answer(imported))
    page.route(f"**/api/recruiting/roles/{a}/say", answer(said))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    send(page, "Add https://www.linkedin.com/in/alice-tan")  # control
    for slug in SLUGS:
        send(page, f"Add https://www.linkedin.com/in/{slug} please")
    batches = [body.get("urls") or [] for body in imported]
    r.check(len(batches) >= 1 and [norm(u) for u in batches[0]] == ["https://www.linkedin.com/in/alice-tan"],
            f"control: a plain link is imported ({batches[:1]})")
    sent = [norm(u) for batch in batches[1:] for u in batch]
    for slug in SLUGS:
        whole = norm(f"https://www.linkedin.com/in/{slug}")
        r.check(whole in sent,
                f"'{unicodedata.normalize('NFC', slug)}' is imported whole (imported {sent}, said {[b.get('text') for b in said]})")
r.finish(console, allow_console=True)

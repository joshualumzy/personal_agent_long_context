"""The drawer is rebuilt from scratch whenever its signature changes (new verdicts while people are rescored,
a reply picked up by the Gmail sync, a contact found). Round 5 and 7 keep the text already typed, but the box
the founder is typing in is replaced by a new one without focus, so every key pressed after the rebuild goes
nowhere. While a rescore runs the page polls every 1.2 s, so a founder editing a draft email or pasting a
reply loses keystrokes mid-sentence. (The criteria review got the same fix in round 1, h02.) The state is
answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r18 keys typed into the drawer after a poll rebuilds it are lost")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
draft = {"kind": "intro", "subject": "Hello", "body": "Hi Alice", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "drafted"
        c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
        c["draft"] = draft
current = {"state": base}
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    body = "#drawer textarea[aria-label='Message']"
    page.click(body)
    page.keyboard.press("End")
    page.keyboard.type(", I saw your")
    # A criterion was added meanwhile; the poll brings Alice's new verdicts.
    later = json.loads(json.dumps(base))
    later["criteria"].append({"id": "c3", "text": "Go", "kind": "nice", "origin": "stated", "active": True, "createdAt": "2026-09-21T00:00:00Z"})
    for c in later["candidates"]:
        c["verdicts"].append({"criterionId": "c3", "satisfied": "unclear", "reasoning": "not stated"})
    current["state"] = later
    page.evaluate("() => refresh()")
    page.wait_for_timeout(400)
    page.keyboard.type(" talk at PyCon")  # the founder is still typing
    page.wait_for_timeout(200)
    value = page.input_value(body) if page.locator(body).count() else None
    r.check(value is not None and "Hi Alice, I saw your" in value, f"control: the text typed before the poll is kept ({value!r})")
    r.check(value == "Hi Alice, I saw your talk at PyCon", f"every key typed lands in the draft (draft is {value!r})")
r.finish(console)

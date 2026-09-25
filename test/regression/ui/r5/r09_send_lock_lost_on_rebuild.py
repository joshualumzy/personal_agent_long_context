"""The send lock added in round 4 lives in one drawer build (`let sending` inside outreachPanel). Sending to a
person with no known email: the founder types the address and presses "I sent it myself". The save answers
with the address now stored, which changes signature() (contact), so the drawer is rebuilt with fresh,
unlocked buttons while /send is still in flight. A second press on the rebuilt button saves and sends again:
two /send requests for one message. Save and send are answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r09 the send lock is lost when the save rebuilds the drawer")
a = "rolea"
base = state(a)
target = next(c for c in base["candidates"] if c["tier"] == 100)
for c in base["candidates"]:
    if c["id"] == target["id"]:
        c["stage"] = "drafted"
        c.pop("contact", None)
        c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Hi there", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
saved = json.loads(json.dumps(base))
for c in saved["candidates"]:
    if c["id"] == target["id"]:
        c["contact"] = {"email": "someone@example.com", "provider": "founder", "status": "verified"}
sends = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(base)))
    page.route(f"**/candidates/{target['id']}/draft", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps({"result": {"saved": True}, "state": saved})))
    page.route(f"**/candidates/{target['id']}/send", lambda route: sends.append(route))  # held
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{target['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    page.fill("#drawer input[aria-label='To']", "someone@example.com")
    button = page.locator("#drawer button:has-text('I sent it myself')")
    button.click()
    page.wait_for_function(f"() => true")
    page.wait_for_timeout(300)
    r.check(len(sends) == 1, f"control: the first /send is in flight ({len(sends)})")
    button.click(force=True)  # the founder presses again while the send has not answered
    page.wait_for_timeout(400)
    r.check(len(sends) == 1, f"one /send for one press-and-wait (sends: {len(sends)})")
    for route in sends:
        route.fulfill(status=200, content_type="application/json", body='{"result":{"message":"Recorded."}}')
    page.wait_for_timeout(300)
r.finish(console)

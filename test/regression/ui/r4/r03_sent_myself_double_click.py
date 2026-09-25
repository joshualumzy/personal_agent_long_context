"""'I sent it myself' (and 'Send from Gmail') first saves the draft with call() WITHOUT a button, so nothing
is disabled while the save is in flight. A second click during the save runs a second save and then a
second /send. The first send records the message; the second answers an error for the draft that is gone
(or, with Gmail, is a second send attempt). Save and send are answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r03 double click on 'I sent it myself' saves and sends twice")
a = role_a()
target = next(c for c in state(a)["candidates"] if c["tier"] == 100)

def rewrite(route):
    response = route.fetch()
    data = response.json()
    for c in data["candidates"]:
        if c["id"] == target["id"]:
            c["stage"] = "drafted"
            c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Hi there", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
    route.fulfill(response=response, body=json.dumps(data))

saves, sends = [], []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
    page.route(f"**/candidates/{target['id']}/draft", lambda route: saves.append(route))  # held
    page.route(f"**/candidates/{target['id']}/send", lambda route: (sends.append(route.request.post_data),
               route.fulfill(status=200, content_type="application/json", body='{"result":{"message":"Recorded."}}')))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{target['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    button = page.locator("#drawer button:has-text('I sent it myself')")
    button.click()
    page.wait_for_timeout(200)
    button.click(force=True)  # second click while the save is still in flight (a disabled button ignores it)
    page.wait_for_timeout(300)
    r.check(len(saves) == 1, f"one save request for one intent (saves: {len(saves)})")
    for route in saves:
        route.fulfill(status=200, content_type="application/json", body='{"result":{"saved":true}}')
    page.wait_for_timeout(600)
    r.check(len(sends) == 1, f"one /send for one intent (sends: {len(sends)})")
r.finish(console)

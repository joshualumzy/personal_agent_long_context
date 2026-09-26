"""Outreach draft with no email found: typing an address into 'To' must make 'Open in Gmail to send' usable.
(Since the S2 merge the page opens the founder's own Gmail instead of sending from the server.)
State is rewritten in the browser to say Gmail is connected and the candidate has a draft without contact."""
import json
from common import *

r = Result("h12 the Gmail link stays disabled after typing an email")
a = role_a()
target = next(c for c in state(a)["candidates"] if c["tier"] == 100)

def rewrite(route):
    response = route.fetch()
    data = response.json()
    s = data if "role" in data else data.get("state")
    s["integrations"]["gmail"] = {"email": "founder@example.com"}
    for c in s["candidates"]:
        if c["id"] == target["id"]:
            c["stage"] = "drafted"
            c["contact"] = None
            c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Hi there", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
    route.fulfill(response=response, body=json.dumps(data))

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
    sent = []
    page.route(f"**/api/recruiting/roles/{a}/candidates/*/send", lambda route: (sent.append(1), route.fulfill(status=200, body='{}', content_type='application/json')))
    page.route(f"**/api/recruiting/roles/{a}/candidates/*/draft", lambda route: route.fulfill(status=200, body='{"result":null}', content_type='application/json'))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{target['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    send = page.locator("#drawer a:has-text('Open in Gmail to send')")
    r.check(send.get_attribute("aria-disabled") == "true", "disabled while there is no address (expected)")
    page.fill("#drawer input[aria-label='To']", "person@example.com")
    page.wait_for_timeout(200)
    r.check(send.get_attribute("aria-disabled") != "true", "usable after typing an address")
r.finish(console)

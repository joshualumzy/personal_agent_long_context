"""Drawer: an unsaved draft edit for X survives polls, never shows up in Y's draft, and Y's drawer shows Y's data."""
import json
from common import *

r = Result("h13 drawer draft isolation")
a = role_a()
pool = [c for c in state(a)["candidates"] if c["tier"] == 100][:2]
x, y = pool

def rewrite(route):
    response = route.fetch()
    data = response.json()
    s = data if "role" in data else data.get("state")
    for c in s["candidates"]:
        if c["id"] in (x["id"], y["id"]):
            c["stage"] = "drafted"
            c["draft"] = {"kind": "intro", "subject": f"For {c['profile']['name']}", "body": f"Body for {c['profile']['name']}", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
    route.fulfill(response=response, body=json.dumps(data))

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    node = lambda c: page.locator(f"#nodes .node[aria-label^='{c['profile']['name']},']")
    node(x).click()
    page.click("#drawer .tab:has-text('Outreach')")
    page.fill("#drawer textarea[aria-label='Message']", "EDITED for X")
    with page.expect_response(lambda resp: resp.url.endswith("/state"), timeout=12000):
        pass
    page.wait_for_timeout(300)
    r.check(page.input_value("#drawer textarea[aria-label='Message']") == "EDITED for X", "unsaved edit survives a poll")
    node(y).click(force=True)
    page.wait_for_timeout(300)
    r.check(page.text_content("#drawer h3") == y["profile"]["name"], "drawer shows Y")
    page.click("#drawer .tab:has-text('Outreach')")
    body = page.input_value("#drawer textarea[aria-label='Message']")
    r.check(body == f"Body for {y['profile']['name']}", f"Y's draft is Y's ({body!r})")
r.finish(console)

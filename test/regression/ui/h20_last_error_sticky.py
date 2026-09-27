"""A background failure (state.lastError) shows a red banner. The founder must be able to get rid of it:
the server has POST /roles/:id/dismiss-error, but the page never calls it, so the banner returns on every poll.
State is rewritten in the browser to carry a lastError."""
import json
from common import *

r = Result("h20 background error banner can never be dismissed")
a = role_a()
dismissed = []

def rewrite(route):
    response = route.fetch()
    data = response.json()
    s = data if "role" in data else data.get("state")
    if not dismissed:
        s["lastError"] = "Scoring: upstream timeout"
    route.fulfill(response=response, body=json.dumps(data))

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
    page.route(f"**/api/recruiting/roles/{a}/dismiss-error", lambda route: (dismissed.append(1), route.continue_()))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    r.check(page.is_visible("#error"), "banner shows the background error")
    controls = page.locator("#error button, #error a").count()
    r.check(controls > 0, f"banner offers a way to dismiss it (controls: {controls})")
    if controls:
        page.locator("#error button, #error a").first.click()
    with page.expect_response(lambda resp: resp.url.endswith("/state"), timeout=12000):
        pass
    page.wait_for_timeout(300)
    r.check(not page.is_visible("#error"), "banner gone after dismissing and a poll")
r.finish(console)

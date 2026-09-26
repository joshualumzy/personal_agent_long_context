""""Find email and draft" disables only its own button while the (slow: email lookups and a model draft)
request runs. Anything that rebuilds the drawer meanwhile (looking at the Career tab and back, or a poll that
brings a changed contact or verdicts) puts a fresh, enabled "Find email and draft" button on screen, and a
second press starts a second outreach for the same person. The same holds for Keep, Pass, Add reply and
Mark as hired. The outreach request is held by the test; the server is
untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r16 find-email-and-draft can be started twice after a drawer rebuild")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
current = {"state": base}
posts = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.route(f"**/candidates/{alice['id']}/outreach", lambda route: posts.append(route))  # held
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    page.click("#drawer button:has-text('Find email and draft')")
    page.wait_for_timeout(300)
    r.check(len(posts) == 1, f"control: one outreach request is running ({len(posts)})")
    later = base
    page.click("#drawer .tab:has-text('Career')")
    page.click("#drawer .tab:has-text('Outreach')")
    page.wait_for_timeout(200)
    button = page.locator("#drawer button:has-text('Find email and draft')")
    if button.count() and button.first.is_enabled():
        button.first.click()
        page.wait_for_timeout(300)
    r.check(len(posts) == 1, f"one press, one outreach request (sent {len(posts)})")
    for route in posts:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": {}, "state": later}))
r.finish(console)

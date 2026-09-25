"""Pressing Enter in the composer while the previous message is still in flight (send button disabled)
must not send it again. No poll is involved: Enter is pressed 300ms after clicking send. /say is intercepted."""
import json
from common import *

r = Result("h17b Enter resubmits while busy")
a = role_a()
held = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/say", lambda route: held.append(route))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.fill("#say", "Remote is fine after all")
    page.click("#say-form .send")
    page.wait_for_timeout(300)
    r.check(page.is_disabled("#say-form .send"), "send button disabled while in flight")
    page.press("#say", "Enter")
    page.wait_for_timeout(300)
    r.check(len(held) == 1, f"Enter while busy sends nothing (requests: {len(held)})")
    for route in held:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": {"message": "ok"}, "state": state(a)}))
r.finish(console)

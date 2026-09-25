"""While a message to the agent is in flight the send button stays disabled, so a poll must not re-enable it
and let the founder send the same instruction twice. /say is intercepted (the model is never called)."""
import json
from common import *

r = Result("h17 send re-enabled mid-request by polling")
a = role_a()
held = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/say", lambda route: held.append(route))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.fill("#say", "Remote is fine after all")
    page.click("#say-form .send")
    page.wait_for_timeout(300)
    r.check(page.is_disabled("#say-form .send"), "send disabled right after sending")
    with page.expect_response(lambda resp: resp.url.endswith(f"/roles/{a}/state"), timeout=12000):
        pass
    page.wait_for_timeout(300)
    r.check(page.is_disabled("#say-form .send"), "send still disabled after a poll while /say is in flight")
    try:
        page.click("#say-form .send", timeout=2000)  # a real click; only possible if the poll re-enabled it
    except Exception:
        pass
    page.wait_for_timeout(300)
    r.check(len(held) == 1, f"only one /say request sent (sent {len(held)})")
    for route in held:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": {"message": "ok"}, "state": state(a)}))
r.finish(console)

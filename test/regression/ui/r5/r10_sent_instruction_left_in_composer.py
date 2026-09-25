"""The founder tells role A's agent something ("drop the Singapore requirement") and switches to role B
before the answer. The instruction is carried out on A, but call() drops the answer (view changed), so the
submit handler takes it as a failure: it keeps the text in the composer and clears the reply. Role B is now
on screen with A's instruction waiting in its composer and no sign it was done; pressing Enter applies it
to B. /say for role A is answered by the test (success); the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r10 an instruction carried out on one role stays in the composer of the next")
held = []
said_b = []
with browser_page() as (page, console):
    page.route("**/api/recruiting/roles/rolea/say", lambda route: held.append(route))
    page.route("**/api/recruiting/roles/roleb/say", lambda route: (said_b.append(route.request.post_data), route.fulfill(
        status=200, content_type="application/json", body='{"result":{"message":"ok"}}')))
    page.goto(f"{BASE}/recruiting?role=rolea")
    wait_board(page)
    page.fill("#say", "drop the Singapore requirement")
    page.press("#say", "Enter")
    page.wait_for_timeout(200)
    r.check(len(held) == 1, f"control: role A's instruction is in flight ({len(held)})")
    page.select_option("#role-select", "roleb")
    page.wait_for_function("() => document.querySelector('#role-title').textContent === 'Designer'")
    a_state = state("rolea")
    held[0].fulfill(status=200, content_type="application/json",
                    body=json.dumps({"result": {"message": "Done: Singapore removed."}, "state": a_state}))
    page.wait_for_timeout(400)
    left = page.input_value("#say")
    r.check(left.strip() != "drop the Singapore requirement",
            f"role B's composer does not offer A's already-applied instruction for sending again (composer: {left!r})")
r.finish(console)

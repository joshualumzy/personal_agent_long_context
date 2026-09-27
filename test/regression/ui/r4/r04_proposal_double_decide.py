"""Proposal buttons are rebuilt by every poll (renderProposals on each render), so the button that was
disabled while "Add criterion" is in flight is replaced by a fresh, enabled one. A second press sends a
second decision for the same proposal. The proposal is injected into the state by the test and the
decision POST is held and answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r04 proposal can be decided twice while the first decision is in flight")
a = role_a()
proposal = {"id": "prop1", "type": "criterion", "status": "pending", "createdAt": "2026-09-20T00:00:00Z",
            "text": "Has shipped a startup product", "kind": "nice", "rationale": "You kept three founders-to-be.",
            "supportingCandidateIds": []}

def rewrite(route):
    response = route.fetch()
    data = response.json()
    data["proposals"] = [proposal]
    route.fulfill(response=response, body=json.dumps(data))

decisions = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
    page.route(f"**/api/recruiting/roles/{a}/proposals/prop1", lambda route: decisions.append(route))  # held
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click("#proposals button:has-text('Add criterion')")
    page.wait_for_timeout(200)
    r.check(len(decisions) == 1, "first decision is in flight")
    # the next poll arrives while the decision is still pending (bounded by the 5 s poll interval)
    with page.expect_response(lambda resp: resp.url.endswith(f"/roles/{a}/state"), timeout=8000):
        pass
    page.wait_for_timeout(300)
    page.locator("#proposals button:has-text('Add criterion')").click(force=True)
    page.wait_for_timeout(300)
    r.check(len(decisions) == 1, f"one decision for one proposal (decision requests: {len(decisions)})")
    for route in decisions:
        route.fulfill(status=200, content_type="application/json", body='{"result":{"accepted":true}}')
r.finish(console)

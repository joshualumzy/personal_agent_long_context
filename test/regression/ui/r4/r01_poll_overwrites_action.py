"""A background poll (GET /state) that left before an action but answers after it paints the older state
over the action's result: the founder passes a candidate, the drawer shows "Closed", then the late poll
brings the person back into the orbit with Keep/Pass buttons again.
Timing is controlled by holding the poll request; the Pass POST is answered by the test (server untouched)."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r01 late poll response overwrites the result of an action")
a = role_a()
before = state(a)
target = next(c for c in before["candidates"] if c["tier"] == 100 and c["stage"] != "closed")
after = json.loads(json.dumps(before))
for c in after["candidates"]:
    if c["id"] == target["id"]:
        c["stage"], c["closedReason"] = "closed", "passed"

held = []
hold = {"on": False}

def on_state(route):
    if hold["on"] and not held:
        held.append(route)
    else:
        route.continue_()

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", on_state)
    page.route(f"**/api/recruiting/roles/{a}/candidates/{target['id']}/feedback",
               lambda route: route.fulfill(status=200, content_type="application/json",
                                           body=json.dumps({"result": {"message": "ok"}, "state": after})))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    name = target["profile"]["name"]
    page.click(f"#nodes .node[aria-label^={json.dumps(name)}]")
    page.wait_for_selector("#drawer:not([hidden]) .decide")
    hold["on"] = True
    for _ in range(80):  # the next poll leaves within 5 s; it is held, not slept on
        if held:
            break
        page.wait_for_timeout(100)
    r.check(bool(held), "a poll request is in flight (held)")
    page.click("#drawer .decide button.warn")  # Pass
    page.wait_for_selector("#drawer .fact:has-text('Closed')")
    nodes_after_pass = page.locator(f"#nodes .node[aria-label^={json.dumps(name)}]").count()
    # the poll that left before the Pass now answers with the older state
    held[0].fulfill(status=200, content_type="application/json", body=json.dumps(before))
    page.wait_for_timeout(800)
    node_back = page.locator(f"#nodes .node[aria-label^={json.dumps(name)}]:not(.entering)").count()
    decide_back = page.locator("#drawer .decide").count()
    r.check(node_back == 0, f"{name} stays out of the orbit after being passed (nodes after pass: {nodes_after_pass}, after late poll: {node_back})")
    r.check(decide_back == 0, f"drawer still says Closed, no Keep/Pass buttons again (decide rows: {decide_back})")
r.finish(console)

"""When "Confirm and search" fails (the search is down: /confirm answers 502), the page still sets
draftCriteria = null. The review stays on screen, but "Add a criterion" then throws
(draftCriteria.push on null) and a retried Confirm posts {criteria: null}, which the server refuses.
Both requests are answered by the test; polls are held so nothing rebuilds the review meanwhile."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r02 review is broken after a failed confirm")
d = role_draft()
draft_state = state(d)
held, drafts = [], []
loaded = {"n": 0}

def on_state(route):
    loaded["n"] += 1
    if loaded["n"] == 1:
        route.continue_()
    else:
        held.append(route)  # polls never answer during the test

def on_draft(route):
    drafts.append(json.loads(route.request.post_data or "{}"))
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": {"refused": []}, "state": draft_state}))

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{d}/state", on_state)
    page.route(f"**/api/recruiting/roles/{d}/criteria/draft", on_draft)
    page.route(f"**/api/recruiting/roles/{d}/confirm", lambda route: route.fulfill(
        status=502, content_type="application/json", body=json.dumps({"error": "upstream", "message": "The search service did not answer."})))
    page.goto(f"{BASE}/recruiting?role={d}")
    page.wait_for_selector("#review:not([hidden]) #draft-criteria li")
    rows_before = page.locator("#draft-criteria li").count()
    page.click("#confirm")
    page.wait_for_selector("#error:not([hidden])")
    r.check(page.is_visible("#review"), "review is still on screen after the failed confirm")
    page.click("#add-criterion")
    page.wait_for_timeout(300)
    rows_after = page.locator("#draft-criteria li").count()
    r.check(rows_after == rows_before + 1, f"'Add a criterion' adds a row after a failed confirm ({rows_before} -> {rows_after})")
    page.click("#confirm")
    page.wait_for_timeout(500)
    last = drafts[-1] if drafts else {}
    r.check(isinstance(last.get("criteria"), list), f"retried confirm sends the criteria list (sent criteria={json.dumps(last.get('criteria'))[:80]})")
pageerrors = [e for e in console.errors if e.startswith('pageerror')]
r.check(not pageerrors, f'no page errors ({pageerrors})')
r.finish(console, allow_console=True)

"""XSS: candidate name/headline/work history, role title, proposal text, verdict reasoning, messages and draft
containing HTML must render as text. The state response is rewritten in the browser (server untouched)."""
import json
from common import *

X = '<img src=x onerror=alert(1)>'
r = Result("h10 xss via mocked state")
a = role_a()

def rewrite_state(route):
    response = route.fetch()
    data = response.json()
    s = data if "role" in data else data.get("state")
    s["role"]["title"] += X
    for c in s["candidates"]:
        c["profile"]["name"] = "Eve " + X
        c["profile"]["headline"] += X
        c["profile"]["summary"] = "## About\n" + X + " <script>alert(2)</script>"
        for w in c["profile"]["workHistory"]:
            w["company"] += X
        c["verdicts"] = [{"satisfied": "yes", "reasoning": X} for _ in c["verdicts"]]
        c["messages"] = [{"direction": "inbound", "channel": "email", "at": "2026-09-01T00:00:00Z", "text": X}]
        c["stage"] = "replied"
        c["draft"] = {"kind": "intro", "subject": X, "body": X, "warnings": [X], "createdAt": "2026-09-01"}
    s["proposals"] = [{"id": "p1", "type": "criterion", "rationale": X, "kind": "must", "text": X}]
    route.fulfill(response=response, body=json.dumps(data))

def rewrite_roles(route):
    response = route.fetch()
    data = response.json()
    for role in data["roles"]:
        role["title"] += X
    route.fulfill(response=response, body=json.dumps(data))

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", rewrite_state)
    page.route("**/api/recruiting/roles", rewrite_roles)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.locator("#nodes .node").first.click()
    for tab in ["Why they fit", "Career", "Outreach"]:
        page.click(f"#drawer .tab:has-text('{tab}')")
        page.wait_for_timeout(200)
        r.check(page.evaluate("document.querySelectorAll('img, script:not([src])').length") == 0, f"{tab}: no injected elements")
    r.check(X in page.text_content("#drawer h3"), "name shown literally")
    r.check(X in page.text_content("#role-title"), "role title shown literally")
    page.wait_for_timeout(500)
r.finish(console, allow_console=True)

"""The round-4 fix put every criterion's id, text and kind into signature(), so the drawer is rebuilt
whenever any criterion changes, whichever tab is open. The founder is editing a draft email on the Outreach
tab (which shows no criteria); a poll brings a criteria change made elsewhere (a must turned into a
nice-to-have from the chat; verdicts and everything about this person unchanged). The drawer is rebuilt
from the stored draft and the founder's unsaved text is gone. State and polls are answered by the test."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r08 a criteria change wipes the draft being edited on the Outreach tab")
a = "rolea"
base = state(a)
target = next(c for c in base["candidates"] if c["tier"] == 100)
for c in base["candidates"]:
    if c["id"] == target["id"]:
        c["stage"] = "drafted"
        c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Stored draft body", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
after = json.loads(json.dumps(base))
must = next(c for c in after["criteria"] if c["kind"] == "must")
must["kind"] = "nice"
phase = {"after": False}
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(after if phase["after"] else base)))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{target['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    page.fill("#drawer textarea[aria-label='Message']", "Hi, my own carefully written words")
    phase["after"] = True
    page.evaluate("() => refresh()")  # the next poll
    page.wait_for_function("() => document.querySelector('#criteria .chip').title === 'Nice to have'")
    page.wait_for_timeout(200)
    body = page.input_value("#drawer textarea[aria-label='Message']")
    r.check(body == "Hi, my own carefully written words", f"the unsaved draft text survives the poll (now {body!r})")
r.finish(console)

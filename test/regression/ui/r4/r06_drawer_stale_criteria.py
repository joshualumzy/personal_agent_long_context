"""The candidate drawer is rebuilt only when signature(candidate) changes; the signature holds the
candidate's verdicts but not the criteria they are listed against. After the founder turns a must into a
nice-to-have (composer: "make Figma a nice-to-have"; set_kind keeps verdicts), a candidate whose verdicts
and tier did not change keeps showing "must" in "Why they fit" until the drawer is closed and reopened.
The /say answer and later polls are supplied by the test (the server is untouched)."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r06 open drawer keeps showing criteria as they were before a change")
a = role_a()
before = state(a)
target = next(c for c in before["candidates"] if c["tier"] == 100 and all(v and v["satisfied"] == "yes" for v in c["verdicts"]))
musts = [c for c in before["criteria"] if c["kind"] == "must"]
after = json.loads(json.dumps(before))
changed = next(c for c in after["criteria"] if c["id"] == musts[0]["id"])
changed["kind"] = "nice"
said = {"on": False}
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/say", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps({"result": {"message": "Done."}, "state": after})))
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(after if said["on"] else before)))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^={json.dumps(target['profile']['name'] + ',')}]")
    page.wait_for_selector("#drawer:not([hidden]) .verdicts .criterion")
    said["on"] = True
    page.fill("#say", f"make {changed['text']} a nice-to-have")
    page.press("#say", "Enter")
    page.wait_for_function("() => document.querySelector('#agent-reply').textContent === 'Done.'")
    page.wait_for_timeout(300)
    index = [c["id"] for c in after["criteria"]].index(changed["id"])
    chip = page.locator("#criteria .chip").nth(index).get_attribute("title")
    shown = page.locator("#drawer .verdicts .criterion small").nth(index).text_content()
    r.check(chip == "Nice to have", f"control: the criteria chip shows the change ({chip!r})")
    r.check(shown == "nice to have", f"the open drawer shows {changed['text']!r} as nice to have (drawer says {shown!r})")
r.finish(console)

"""Round 7 keeps a pasted reply (and a Keep/Pass reason) across drawer rebuilds until "Add reply" works,
clearing it only when call() answers with a result. When the founder switches roles while the (slow: the
reply is read by a model) request runs, call() answers undefined for a stale view even though the reply was
recorded, so the text is kept. Back on the role, the reply shows in the thread and the same text still sits
in "Their reply", looking unsent; pressing "Add reply" again sends it a second time. (Round 5 fixed exactly
this for the composer with onStale.) The state and reply request are answered by the test; the server is
untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r17 a reply added while the founder looked at another role stays in the box as if unsent")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "contacted"
        c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
        c["messages"] = [{"direction": "outbound", "channel": "email", "at": "2026-09-10T00:00:00Z", "text": "Hi Alice"}]
TEXT = "Thanks, happy to talk on Tuesday."
later = json.loads(json.dumps(base))
for c in later["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "replied"
        c["messages"].append({"direction": "inbound", "channel": "email", "at": "2026-09-11T00:00:00Z", "text": TEXT})
current = {"state": base}
held = []
posted = []

def reply_route(route):
    posted.append(route.request.post_data)
    held.append(route)

with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(current["state"])))
    page.route(f"**/roles/{a}/candidates/{alice['id']}/reply", reply_route)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    box = "#drawer textarea[placeholder^='Paste or dictate']"
    page.fill(box, TEXT)
    page.click("#drawer button:has-text('Add reply')")
    page.wait_for_timeout(200)
    r.check(len(held) == 1, f"control: the reply is on its way ({len(held)})")
    page.select_option("#role-select", "roleb")  # the founder looks at another role meanwhile
    page.wait_for_function("() => document.querySelector('#role-title').textContent !== ''")
    page.wait_for_timeout(300)
    current["state"] = later  # the reply was recorded
    held[0].fulfill(status=200, content_type="application/json",
                    body=json.dumps({"result": {"message": "Recorded."}, "state": later}))
    page.wait_for_timeout(300)
    page.select_option("#role-select", a)
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    page.wait_for_timeout(200)
    thread = page.text_content("#drawer .thread") or ""
    r.check(TEXT in thread, "control: the reply is recorded and shown in the thread")
    value = page.input_value(box) if page.locator(box).count() else ""
    r.check(value != TEXT, f"the recorded reply is not left in 'Their reply' as if unsent (box holds {value!r})")
r.finish(console)

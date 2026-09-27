"""Round 5 made the send lock per person and, when a send ends, forces the drawer to rebuild
(sendAfterSave's finally: detailSignature = ""; renderDetail()). The drawer on screen by then may be
someone else's. The founder presses "I sent it myself" for Alice, opens Bob while it records, and types
why they pass on him; when Alice's send answers, Bob's drawer is rebuilt from scratch and the reason
(or a reply being pasted) is gone. Save and send are answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r11 a send finishing rebuilds whatever drawer is open and wipes what the founder typed there")
a = "rolea"
base = state(a)
alice, bob = base["candidates"][0], base["candidates"][1]
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "drafted"
        c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
        c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Hi Alice", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
sent = json.loads(json.dumps(base))
for c in sent["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "contacted"
        c.pop("draft")
        c["messages"] = [{"direction": "outbound", "channel": "email", "at": "2026-09-02T00:00:00Z", "text": "Hi Alice"}]
sends = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(base)))
    page.route(f"**/candidates/{alice['id']}/draft", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps({"result": {"saved": True}, "state": base})))
    page.route(f"**/candidates/{alice['id']}/send", lambda route: sends.append(route))  # held
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    page.click("#drawer button:has-text('I sent it myself')")
    page.wait_for_function("() => true")
    page.wait_for_timeout(300)
    r.check(len(sends) == 1, f"control: Alice's /send is in flight ({len(sends)})")
    page.click(f"#nodes .node[aria-label^='{bob['profile']['name']},']")
    page.wait_for_selector(f"#drawer h3:has-text('{bob['profile']['name']}')")
    reason = "#drawer input[placeholder^='Why?']"
    page.fill(reason, "not senior enough for this")
    for route in sends:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"result": {"message": "Recorded."}, "state": sent}))
    page.wait_for_timeout(500)
    who = page.text_content("#drawer h3")
    value = page.input_value(reason) if page.query_selector(reason) else None
    r.check(who == bob["profile"]["name"], f"control: Bob's drawer is still open ({who!r})")
    r.check(value == "not senior enough for this", f"the reason typed in Bob's drawer survives Alice's send finishing (now {value!r})")
r.finish(console)

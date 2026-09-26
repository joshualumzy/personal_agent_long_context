"""typedDrafts keeps unsaved draft text across drawer rebuilds, but save() deletes the whole entry when the
save answers, including anything typed while the save was in flight. The founder presses "Save edits",
keeps typing, and the next rebuild (here: looking at the Career tab and back) puts the draft back to the
text that was saved: the later typing is lost. The save is answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r12 text typed while a draft save is in flight is lost on the next drawer rebuild")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
draft = {"kind": "intro", "subject": "Hello", "body": "Hi Alice", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
for c in base["candidates"]:
    if c["id"] == alice["id"]:
        c["stage"] = "drafted"
        c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
        c["draft"] = draft
saves = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(base)))
    page.route(f"**/candidates/{alice['id']}/draft", lambda route: saves.append(route))  # held
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{alice['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    body = "#drawer textarea[aria-label='Message']"
    page.fill(body, "Hi Alice, first edit")
    page.click("#drawer button:has-text('Save edits')")
    page.wait_for_timeout(200)
    r.check(len(saves) == 1, f"control: the save is in flight ({len(saves)})")
    page.fill(body, "Hi Alice, first edit. And a second thought.")  # typed while the save runs
    saved = json.loads(json.dumps(base))
    for c in saved["candidates"]:
        if c["id"] == alice["id"]:
            c["draft"]["body"] = json.loads(saves[0].request.post_data)["body"]
    base.clear(); base.update(saved)  # polls now see the saved draft too
    saves[0].fulfill(status=200, content_type="application/json", body=json.dumps({"result": {"saved": True}, "state": saved}))
    page.wait_for_timeout(300)
    page.click("#drawer .tab:has-text('Career')")
    page.click("#drawer .tab:has-text('Outreach')")
    value = page.input_value(body)
    r.check("second thought" in value, f"the text typed after pressing Save is still in the draft (now {value!r})")
r.finish(console)

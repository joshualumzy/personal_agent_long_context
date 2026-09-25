"""'I sent it myself' saves the edited draft first. If that save fails, the message must not be marked as sent
(the recorded text would be the old one). Save and send are intercepted; nothing reaches the server."""
import json
from common import *

r = Result("h21 marks as sent even though saving the edit failed")
a = role_a()
target = next(c for c in state(a)["candidates"] if c["tier"] == 100)

def rewrite(route):
    response = route.fetch()
    data = response.json()
    for c in data["candidates"]:
        if c["id"] == target["id"]:
            c["stage"] = "drafted"
            c["draft"] = {"kind": "intro", "subject": "Hello", "body": "Old text", "warnings": [], "createdAt": "2026-09-01T00:00:00Z"}
    route.fulfill(response=response, body=json.dumps(data))

sent = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
    page.route(f"**/candidates/{target['id']}/draft", lambda route: route.fulfill(status=400, content_type="application/json", body='{"message":"Draft could not be saved."}'))
    page.route(f"**/candidates/{target['id']}/send", lambda route: (sent.append(route.request.post_data), route.fulfill(status=200, content_type="application/json", body='{"result":null}')))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click(f"#nodes .node[aria-label^='{target['profile']['name']},']")
    page.click("#drawer .tab:has-text('Outreach')")
    page.fill("#drawer textarea[aria-label='Message']", "New text the founder actually sent")
    page.click("#drawer button:has-text('I sent it myself')")
    page.wait_for_timeout(800)
    r.check(not sent, f"no send recorded after the save failed (send calls: {sent})")
    err = page.text_content("#error") if page.is_visible("#error") else ""
    r.check("could not be saved" in err, f"save error stays visible (banner: {err!r})")
r.finish(console, allow_console=True)

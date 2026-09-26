"""createRole() clears startingNew before its stale check. The founder describes a role, picks another role
while it is created, then presses "New role" to describe a second one. When the first creation answers,
startingNew is false, so the refresh (and every poll after it) opens the newest role over the intake the
founder is typing in, although the comment says a stale creation is "listed, not forced on screen".
POST /roles, the list after it and the new role's state are answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r14 a role created earlier replaces the intake the founder is filling in")
draft = state("roledraft")
new_state = json.loads(json.dumps(draft))
new_state["role"]["title"] = "Brand new role"
listed = api("/api/recruiting/roles")[1]
created = {"done": False}
held = []

def roles_route(route):
    if route.request.method == "POST":
        held.append(route)
    elif created["done"]:
        roles = [{"id": "rolenew", "title": "Brand new role", "confirmed": False, "createdAt": "2026-09-26T00:00:00.000Z",
                  "candidates": 0, "strong": 0}] + listed["roles"]
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"roles": roles}))
    else:
        route.continue_()

with browser_page() as (page, console):
    page.route("**/api/recruiting/roles", roles_route)
    page.route("**/api/recruiting/roles/rolenew/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(new_state)))
    page.goto(f"{BASE}/recruiting?role=rolea")
    wait_board(page)
    page.click("#new-role")
    page.fill("#requirement", "A product designer in Singapore who knows Figma")
    page.click("#intake-form button[type=submit]")
    page.wait_for_timeout(200)
    r.check(len(held) == 1, f"control: the creation is in flight ({len(held)})")
    page.select_option("#role-select", "roleb")
    page.wait_for_function("() => document.querySelector('#role-title').textContent === 'Designer'")
    page.click("#new-role")
    page.fill("#requirement", "A second role I am describing now")
    created["done"] = True
    held[0].fulfill(status=200, content_type="application/json",
                    body=json.dumps({"roleId": "rolenew", "state": new_state, "result": {"refused": []}}))
    page.wait_for_timeout(800)
    intake_shown = page.is_visible("#intake")
    shown = page.text_content("#role-title")
    r.check(intake_shown, f"the intake the founder is filling in stays on screen (showing {shown!r})")
r.finish(console)

"""createRole() is not tied to the view it was asked from. The founder describes a new role, and while the
(slow, model-backed) creation runs, picks another role in the switcher. The creation answer then sets roleId
to the new role without bumping `view`, so the switcher's own refresh, still in flight, is not recognised as
stale: it paints the other role's board while roleId (URL, every action, Delete) is the new role. Here the
page shows "Designer" and "Delete this role" deletes the new draft role.
POST /roles, the switched-to role's state and DELETE are answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r07 a role created while switching roles leaves the screen and the actions on different roles")
draft = state("roledraft")
new_state = json.loads(json.dumps(draft))
new_state["role"]["title"] = "Brand new role"
held = []
deleted = []

def roles_post(route):
    if route.request.method == "POST":
        held.append(("create", route))
    else:
        route.continue_()

def other_state(route):
    held.append(("other", route))

def delete(route):
    if route.request.method == "DELETE":
        deleted.append(route.request.url.rsplit("/", 1)[1])
        route.fulfill(status=200, content_type="application/json", body='{"deleted":true}')
    else:
        route.continue_()

with browser_page() as (page, console):
    page.route("**/api/recruiting/roles", roles_post)
    page.route("**/api/recruiting/roles/roleb/state", other_state)
    page.route("**/api/recruiting/roles/rolenew/state", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(new_state)))
    page.route("**/api/recruiting/roles/*", delete)
    page.goto(f"{BASE}/recruiting?role=rolea")
    wait_board(page)
    page.click("#new-role")
    page.fill("#requirement", "A product designer in Singapore who knows Figma")
    page.click("#intake-form button[type=submit]")
    page.wait_for_function("() => true")
    page.wait_for_timeout(200)
    assert held and held[0][0] == "create", held
    page.select_option("#role-select", "roleb")  # the founder looks at another role meanwhile
    page.wait_for_timeout(300)
    create = held.pop(0)[1]
    create.fulfill(status=200, content_type="application/json",
                   body=json.dumps({"roleId": "rolenew", "state": new_state, "result": {"refused": []}}))
    # Either fix is fine: the new role takes over, or the role the founder switched to stays.
    page.wait_for_timeout(300)
    page.wait_for_timeout(300)
    other = [route for kind, route in held if kind == "other"]
    for route in other:  # the switcher's slow answer arrives last
        route.fulfill(response=route.fetch())
    page.wait_for_timeout(500)
    shown = page.text_content("#role-title")
    url_role = page.evaluate("() => new URLSearchParams(location.search).get('role')")
    page.click("#reset")
    page.click("#reset")
    page.wait_for_timeout(400)
    titles = {"rolea": "Backend engineer", "roleb": "Designer", "rolenew": "Brand new role"}
    target = deleted[0] if deleted else None
    r.check(target is None or titles.get(target) == shown,
            f"Delete acts on the role shown ({shown!r} on screen, URL role {url_role!r}, DELETE sent for {target!r})")
r.finish(console, allow_console=True)

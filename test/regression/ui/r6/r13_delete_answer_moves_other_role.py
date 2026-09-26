"""The Delete handler ends with switchRole(null) whatever is on screen by then. The founder deletes
"Designer", and while the DELETE is on its way picks "Data analyst" in the switcher; when the delete
answers, the page throws them off Data analyst and opens the newest role instead (Backend engineer).
DELETE and the role list after it are answered by the test; the server is untouched."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r13 a delete that answers after a role switch moves the founder off the role they picked")
listed = api("/api/recruiting/roles")[1]
after = {"roles": [role for role in listed["roles"] if role["id"] != "roleb"]}
deleted = {"done": False}
held = []

def roles_list(route):
    if route.request.method == "GET" and deleted["done"]:
        route.fulfill(status=200, content_type="application/json", body=json.dumps(after))
    else:
        route.continue_()

def role_route(route):
    if route.request.method == "DELETE":
        held.append(route)
    else:
        route.continue_()

with browser_page() as (page, console):
    page.route("**/api/recruiting/roles", roles_list)
    page.route("**/api/recruiting/roles/roleb", role_route)
    page.goto(f"{BASE}/recruiting?role=roleb")
    wait_board(page)
    page.click("#reset")
    page.click("#reset")
    page.wait_for_timeout(200)
    r.check(len(held) == 1, f"control: the DELETE for Designer is in flight ({len(held)})")
    page.select_option("#role-select", "roledraft")  # the founder moves on meanwhile
    page.wait_for_function("() => document.querySelector('#role-title').textContent === 'Data analyst'")
    deleted["done"] = True
    held[0].fulfill(status=200, content_type="application/json", body='{"deleted":true}')
    page.wait_for_timeout(800)
    shown = page.text_content("#role-title")
    url_role = page.evaluate("() => new URLSearchParams(location.search).get('role')")
    r.check(shown == "Data analyst" and url_role == "roledraft",
            f"the founder stays on the role they picked (showing {shown!r}, URL role {url_role!r})")
r.finish(console)

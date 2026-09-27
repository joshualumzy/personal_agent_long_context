"""'Delete this role' armed on role A must not delete role B with a single click after switching.
The DELETE is intercepted (never reaches the server), so nothing is destroyed."""
from common import *

r = Result("h03 delete confirmation carries across roles")
a, b = role_a(), role_b()
deleted = []
with browser_page() as (page, console):
    def on_delete(route):
        if route.request.method == "DELETE":
            deleted.append(route.request.url)
            route.fulfill(status=200, content_type="application/json", body='{"roles":[]}')
        else:
            route.continue_()
    page.route("**/api/recruiting/roles/*", on_delete)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click("#reset")  # arms: "Click again to erase"
    r.check(page.text_content("#reset") == "Click again to erase", "first click arms the button")
    page.select_option("#role-select", b)
    page.wait_for_function(f"document.querySelector('#role-title').textContent === {title(b)!r}")
    label = page.text_content("#reset")
    r.check(label == "Delete this role", f"after switching to B the button is disarmed (label: {label!r})")
    page.click("#reset")
    page.wait_for_timeout(800)
    r.check(not deleted, f"one click on role B deletes nothing (DELETE sent: {deleted})")
r.finish(console)

"""'New role' intake: (1) typed text survives several polls; (2) a poll that was already in flight
for the old role when 'New role' was clicked must not replace the intake with the old board."""
from common import *

r = Result("h05 new-role intake vs polling")
a = role_a()
with browser_page() as (page, console):
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click("#new-role")
    page.fill("#requirement", "A head of growth in Jakarta")
    page.wait_for_timeout(11000)  # two poll cycles
    r.check(page.is_visible("#intake"), "intake still visible after two polls")
    r.check(page.input_value("#requirement") == "A head of growth in Jakarta", "typed requirement kept")
    r.check(page.eval_on_selector("#role-select", "s => s.value") == "", "switcher shows 'New role'")

with browser_page() as (page, console2):
    held = []
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    # hold the next poll's /state for A, click New role while it is in flight, then release it
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: held.append(route))
    page.wait_for_timeout(6000)
    r.check(len(held) >= 1, "a poll for A is in flight")
    page.click("#new-role")
    page.fill("#requirement", "A head of growth in Jakarta")
    for route in held:
        route.continue_()
    page.unroute(f"**/api/recruiting/roles/{a}/state")
    page.wait_for_timeout(800)
    r.check(page.is_visible("#intake"), f"intake still visible after the stale poll lands (board visible: {page.is_visible('#board')}, title {page.text_content('#role-title')!r})")
    r.check(not page.is_visible("#top-actions"), "old role's 'Delete this role' not shown on the intake")
console.errors += console2.errors
r.finish(console)

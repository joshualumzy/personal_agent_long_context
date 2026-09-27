"""DESTRUCTIVE: deletes the role in $SACRIFICE (a confirmed role). Full page: after 'Delete this role' twice the page
opens another role cleanly and the switcher drops it. An embedded panel of that role must then say it is gone
instead of showing the deleted board."""
import os
from common import *

r = Result("h16 delete role")
sac = os.environ["SACRIFICE"]
with browser_page() as (page, console):
    page.goto(f"{BASE}/recruiting?role={sac}")
    wait_board(page)
    host = page.context.new_page()
    console2 = Console(); console2.attach(host)
    frame = embed(host, f"embed=1&role={sac}", 1100, 560)
    wait_board(frame)
    page.click("#reset"); page.click("#reset")
    page.wait_for_timeout(1500)
    remaining = [x["id"] for x in roles()]
    r.check(sac not in remaining, "role deleted on the server")
    options = page.eval_on_selector_all("#role-select option", "os => os.map(o => o.value)")
    r.check(sac not in options, f"switcher no longer lists it {options}")
    shown = page.evaluate("new URLSearchParams(location.search).get('role')")
    r.check(shown in remaining, f"page moved to an existing role (URL role={shown})")
    r.check(page.text_content("#role-title") == title(shown), "title matches the opened role")
    r.check(not console.errors, f"full page: no console errors {console.errors}")
    # embedded panel of the deleted role, after a poll
    host.wait_for_timeout(6500)
    view = frame.evaluate("""() => ({ board: !document.querySelector('#board').hidden,
        title: document.querySelector('#role-title').textContent,
        error: document.querySelector('#error').hidden ? '' : document.querySelector('#error').textContent })""")
    r.check(not view["board"] or bool(view["error"]), f"embedded panel stops showing the deleted role's board {view}")
r.finish()

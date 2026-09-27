"""An open candidate drawer must close when switching to a draft role or to 'New role', and its close button must not throw."""
from common import *

r = Result("h15 drawer left open after leaving the board")
a, d = role_a(), role_draft()
for target in ["draft", "new"]:
    with browser_page() as (page, console):
        page.goto(f"{BASE}/recruiting?role={a}")
        wait_board(page)
        page.locator("#nodes .node.t100").first.click()
        page.wait_for_selector("#drawer:not([hidden])")
        name = page.text_content("#drawer h3")
        if target == "draft":
            page.select_option("#role-select", d)
            page.wait_for_selector("#review:not([hidden])")
        else:
            page.click("#new-role")
            page.wait_for_selector("#intake:not([hidden])")
        page.wait_for_timeout(600)
        open_ = page.is_visible("#drawer")
        r.check(not open_, f"{target}: drawer for {name} ({title(a)}) closed after leaving the board (still open: {open_})")
        if open_ and target == "draft":
            posted = []
            page.route("**/candidates/*/feedback", lambda route: (posted.append(route.request.url), route.fulfill(status=404, content_type="application/json", body='{"message":"intercepted"}')))
            page.click("#drawer button:has-text('Keep')")
            page.wait_for_timeout(300)
            r.check(not any(f"/roles/{d}/" in url for url in posted), f"Keep on {name} is not sent to the draft role: {posted}")
        if open_:
            page.click("#drawer .close")
            page.wait_for_timeout(300)
        r.check(not [e for e in console.errors if "status of 404" not in e], f"{target}: no page errors (ignoring the intercepted 404) {console.errors}")
r.finish()

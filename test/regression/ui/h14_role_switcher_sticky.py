"""Role switcher: choosing a role keeps it through polls and a reload, lists every role, and the URL follows."""
from common import *

r = Result("h14 role switcher keeps selection")
a, b, d = role_a(), role_b(), role_draft()
with browser_page() as (page, console):
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    options = page.eval_on_selector_all("#role-select option", "os => os.map(o => o.value)")
    r.check(sorted(options) == sorted(x["id"] for x in roles()), f"switcher lists every role {options}")
    for target in [b, d, a, b]:
        page.select_option("#role-select", target)
        page.wait_for_timeout(300)
    page.wait_for_timeout(11000)
    r.check(page.eval_on_selector("#role-select", "s => s.value") == b, "select still on B after polls")
    r.check(page.text_content("#role-title") == title(b), "title still B after polls")
    r.check(f"role={b}" in page.url, "URL names B")
    page.reload()
    page.wait_for_timeout(2000)
    r.check(page.text_content("#role-title") == title(b), "B after reload")
    page.select_option("#role-select", d)
    page.wait_for_selector("#review:not([hidden])")
    r.check(page.is_hidden("#board"), "draft role shows review only")
r.finish(console)

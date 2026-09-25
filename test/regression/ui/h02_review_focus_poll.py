"""Criteria review: the 5s poll must not steal focus or the caret from a criterion the founder is editing."""
from common import *

r = Result("h02 review edit survives polling")
role = role_draft()
with browser_page() as (page, console):
    page.goto(f"{BASE}/recruiting?role={role}")
    page.wait_for_selector("#review:not([hidden]) #draft-criteria input")
    field = page.locator("#draft-criteria input").first
    field.click()
    page.keyboard.press("End")
    page.keyboard.type(" plus")
    # wait for at least one poll (5s) to land
    with page.expect_response(lambda resp: resp.url.endswith(f"/roles/{role}/state"), timeout=12000):
        pass
    page.wait_for_timeout(300)
    page.keyboard.type(" more")
    info = page.evaluate("""() => ({
      focused: document.activeElement?.getAttribute('aria-label'),
      value: document.querySelector('#draft-criteria input').value,
    })""")
    r.check(info["focused"] == "Criterion 1", f"focus stays in Criterion 1 after a poll (activeElement: {info['focused']})")
    r.check(info["value"].endswith(" plus more"), f"typing after the poll lands in the field (value: {info['value']!r})")
r.finish(console)

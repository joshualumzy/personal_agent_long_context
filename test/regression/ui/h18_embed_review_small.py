"""Embedded 'Review the criteria' panel for an unconfirmed role at the smallest chat frame (360px) and a typical one:
'Confirm and search' must be reachable (on screen or by scrolling the frame)."""
from common import *

r = Result("h18 embedded review reachable")
d = role_draft()
for h in [360, 460]:
    with browser_page(1440, 900) as (page, console):
        frame = embed(page, f"embed=1&role={d}", 1100, h)
        frame.wait_for_selector("#review:not([hidden]) #draft-criteria input")
        frame.locator("#confirm").scroll_into_view_if_needed()
        box = frame.evaluate("() => { const b = document.querySelector('#confirm').getBoundingClientRect(); return [b.top, b.bottom, innerHeight]; }")
        r.check(box[0] >= 0 and box[1] <= box[2] + 1, f"{h}px frame: confirm reachable {box}")
        r.check(not console.errors, f"{h}px: no console errors {console.errors}")
r.finish()

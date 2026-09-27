"""Board view: no console errors, XSS criterion renders as text, page fits one screen at 1440x900 and 1600x900."""
from common import *

r = Result("h01 board layout + xss")
role = role_a()
for width, height in [(1440, 900), (1600, 900)]:
    with browser_page(width, height) as (page, console):
        page.goto(f"{BASE}/recruiting?role={role}")
        wait_board(page)
        m = page.evaluate("""() => ({
          sh: document.scrollingElement.scrollHeight, ih: innerHeight,
          sw: document.scrollingElement.scrollWidth, iw: innerWidth,
          imgs: document.querySelectorAll('img').length,
          chip: [...document.querySelectorAll('#criteria li')].map(li => li.textContent).join(' | '),
          controls: ['#find-more', '#say-form .send', '#reset', '#fast-forward', '#role-select', '#new-role'].map(s => {
            const b = document.querySelector(s).getBoundingClientRect();
            return [s, b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && b.width > 0];
          }),
        })""")
        r.check(m["sh"] <= m["ih"], f"{width}x{height}: no vertical page scroll (scrollHeight {m['sh']} vs {m['ih']})")
        r.check(m["sw"] <= m["iw"], f"{width}x{height}: no horizontal page scroll ({m['sw']} vs {m['iw']})")
        r.check(m["imgs"] == 0 and "<img" in m["chip"], f"criterion HTML rendered as text: {m['chip'][:120]}")
        for selector, visible in m["controls"]:
            r.check(visible, f"{width}x{height}: {selector} fully on screen")
        # open a candidate: fit panel shows the criterion as text too
        page.click("#nodes .node.t100")
        page.wait_for_selector("#drawer:not([hidden])")
        r.check(page.evaluate("document.querySelectorAll('img').length") == 0, "drawer renders criterion as text")
        page.wait_for_timeout(500)
        r.check(not console.errors and not console.dialogs, f"{width}x{height}: no console errors/dialogs {console.errors} {console.dialogs}")
r.finish()

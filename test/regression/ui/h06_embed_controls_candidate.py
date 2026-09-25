"""Embedded panel (?embed=1): hides switcher, delete, skip-a-week, composer and intake; opens the named candidate; fits its frame."""
from common import *

r = Result("h06 embed hides controls and opens candidate")
a = role_a()
st = state(a)
target = next(c for c in st["candidates"] if c["tier"] == 50)
with browser_page(1440, 900) as (page, console):
    frame = embed(page, f"embed=1&role={a}&candidate={target['id']}", 1100, 560)
    wait_board(frame)
    hidden = frame.evaluate("""() => ['#roles', '#top-actions', '#reset', '#fast-forward', '#new-role', '.rail-foot', '#intake', '#say-form']
        .map(s => [s, !document.querySelector(s) || document.querySelector(s).getClientRects().length === 0])""")
    for selector, is_hidden in hidden:
        r.check(is_hidden, f"embed hides {selector}")
    frame.wait_for_selector("#drawer:not([hidden])", timeout=5000)
    r.check(frame.text_content("#drawer h3") == target["profile"]["name"], f"drawer opens {target['profile']['name']}")
    m = frame.evaluate("""() => ({ sh: document.scrollingElement.scrollHeight, ih: innerHeight,
       fm: (() => { const b = document.querySelector('#find-more').getBoundingClientRect(); return [b.top, b.bottom]; })() })""")
    r.check(m["sh"] <= m["ih"], f"embed has no page scroll ({m['sh']} vs {m['ih']})")
    r.check(m["fm"][1] <= m["ih"], f"'Find more people' visible in the frame (bottom {m['fm'][1]} vs {m['ih']})")
r.finish(console)

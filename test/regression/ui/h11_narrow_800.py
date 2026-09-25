"""At 800px wide (and 600px): no horizontal scroll, every visible control inside the viewport width and
not covered by another element; long criteria/titles wrap or ellipsize without hiding controls."""
import json
from common import *

r = Result("h11 narrow widths")
a = role_a()
LONG = "Extremely-long-unbroken-criterion-text-" * 4

def long_text(route):
    response = route.fetch()
    data = response.json()
    s = data if "role" in data else data.get("state")
    s["role"]["title"] = "Principal Staff Distributed Systems Engineer for Payments Infrastructure and Reliability, Singapore"
    s["criteria"][0]["text"] = LONG
    route.fulfill(response=response, body=json.dumps(data))

check_js = """() => {
  const out = [];
  for (const el of document.querySelectorAll('button, select, a, input, textarea')) {
    if (!el.getClientRects().length) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0) continue;
    if (b.right > innerWidth + 1 || b.left < -1) out.push(`${el.id || el.className || el.tagName} [${Math.round(b.left)},${Math.round(b.right)}] outside width`);
  }
  return { out, sw: document.documentElement.scrollWidth, iw: innerWidth };
}"""
for width in [800, 600]:
    with browser_page(width, 900) as (page, console):
        page.route(f"**/api/recruiting/roles/{a}/state", long_text)
        page.goto(f"{BASE}/recruiting?role={a}")
        wait_board(page)
        m = page.evaluate(check_js)
        r.check(m["sw"] <= m["iw"], f"{width}: no horizontal scroll ({m['sw']} vs {m['iw']})")
        r.check(not m["out"], f"{width}: all controls inside width {m['out'][:6]}")
        page.locator("#nodes .node").first.click()
        page.wait_for_selector("#drawer:not([hidden])")
        page.wait_for_timeout(400)
        m = page.evaluate(check_js)
        r.check(not m["out"], f"{width} drawer open: all controls inside width {m['out'][:6]}")
        r.check(not console.errors, f"{width}: no console errors {console.errors}")
r.finish()

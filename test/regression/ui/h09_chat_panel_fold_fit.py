"""Chat panels: newest panel live, older ones folded; 'Show this panel' reopens (and folds the other);
the live iframe fits inside the visible chat area at 1440x900 and 1600x900. Also model HTML in tokens is inert."""
from common import *
from chatfake import INIT, turn, send

r = Result("h09 chat panel fold/reopen/fit")
a = role_a()
fit_js = """() => {
  const box = document.querySelector('#messages-container').getBoundingClientRect();
  const live = document.querySelector('.chat-block.live');
  const f = live.querySelector('iframe').getBoundingClientRect();
  const blk = live.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom, ftop: f.top, fbottom: f.bottom, btop: blk.top, bbottom: blk.bottom, fh: f.height };
}"""
for width, height in [(1440, 900), (1600, 900)]:
    with browser_page(width, height) as (page, console):
        page.add_init_script(INIT)
        page.goto(f"{BASE}/")
        send(page, "one", turn("First <img src=x onerror=alert(1)> panel.", [{"type": "recruiting", "view": "pool", "roleId": a}]))
        page.wait_for_timeout(1500)
        m = page.evaluate(fit_js)
        print("  ", width, height, m)
        r.check(m["ftop"] >= m["top"] and m["fbottom"] <= m["bottom"], f"{width}x{height}: live iframe inside visible chat area")
        r.check(m["btop"] >= m["top"] and m["bbottom"] <= m["bottom"], f"{width}x{height}: whole panel (header + iframe) inside visible chat area")
        r.check(page.locator(".message-text img[onerror]").count() == 0, "model HTML sanitised")
        send(page, "two", turn("Second panel.", [{"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": "x"}]))
        blocks = page.locator(".chat-block")
        r.check(blocks.count() == 2, "two panels")
        r.check("live" not in blocks.nth(0).get_attribute("class") and blocks.nth(0).locator(".chat-block-reopen").count() == 1, "first panel folded")
        r.check(page.locator(".chat-block.live").count() == 1 and blocks.nth(1).locator("iframe").count() == 1, "second panel live")
        blocks.nth(0).locator(".chat-block-reopen").click()
        r.check(blocks.nth(0).locator("iframe").count() == 1, "reopened first panel")
        r.check(blocks.nth(1).locator(".chat-block-reopen").count() == 1, "second folded after reopening first")
        blocks.nth(1).locator(".chat-block-reopen").click()
        r.check(page.locator(".chat-block.live").count() == 1 and blocks.nth(1).locator("iframe").count() == 1, "reopen again swaps back")
        r.check(not console.dialogs, "no alert from model text")
        page.wait_for_timeout(1000)
        r.check(not [e for e in console.errors if "404" not in e], f"no console errors {console.errors}")
r.finish()

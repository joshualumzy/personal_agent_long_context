"""Embedded panel naming a role that does not exist (deleted, or a bad id) must tell the user, not show an empty shell."""
from common import *

r = Result("h07 embed with a missing role")
with browser_page(1440, 900) as (page, console):
    frame = embed(page, "embed=1&role=doesnotexist&candidate=x", 1100, 560)
    frame.wait_for_timeout(2500)
    view = frame.evaluate("""() => ({
      title: document.querySelector('#role-title').textContent,
      status: document.querySelector('#status-line').textContent,
      error: document.querySelector('#error').hidden ? '' : document.querySelector('#error').textContent,
      visibleSections: ['#intake', '#review', '#board', '#drawer'].filter(s => document.querySelector(s).getClientRects().length > 0),
      text: document.body.innerText.trim(),
    })""")
    print("  page text:", repr(view["text"]))
    r.check(bool(view["error"]) or "not" in view["status"].lower(),
            f"a message says the role is gone (title {view['title']!r}, status {view['status']!r}, error {view['error']!r}, sections {view['visibleSections']})")
    r.check(view["title"] != "Who do you need?", "does not show the intake heading with no intake under it")
r.finish(console, allow_console=True)

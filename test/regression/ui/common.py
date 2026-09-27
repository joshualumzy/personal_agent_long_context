"""Shared helpers for the UI bug hunt. Each hNN_*.py script exits 1 when the bug reproduces.

Server: BASE (default http://localhost:3241). Role ids come from env or are discovered via the API:
  ROLE_A  a confirmed role with scored candidates
  ROLE_B  a second confirmed role
  ROLE_DRAFT  an unconfirmed role (criteria review)
"""
import json
import os
import sys
import urllib.request
from contextlib import contextmanager

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:3241")


def api(path, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null")


def roles():
    return api("/api/recruiting/roles")[1]["roles"]


def confirmed_roles():
    return [role for role in roles() if role["confirmed"] and role["candidates"] > 0]


def role_a():
    return os.environ.get("ROLE_A") or confirmed_roles()[-1]["id"]  # the oldest confirmed role with candidates


def role_b():
    if os.environ.get("ROLE_B"):
        return os.environ["ROLE_B"]
    others = [role["id"] for role in roles() if role["confirmed"] and role["id"] != role_a()]
    return others[0]


def role_draft():
    return os.environ.get("ROLE_DRAFT") or [role["id"] for role in roles() if not role["confirmed"]][-1]


def state(role_id):
    return api(f"/api/recruiting/roles/{role_id}/state")[1]


def title(role_id):
    return state(role_id)["role"]["title"]


class Console:
    def __init__(self):
        self.errors = []
        self.dialogs = []

    def attach(self, page):
        page.on("console", lambda message: message.type == "error" and self.errors.append(f"console: {message.text}"))
        page.on("pageerror", lambda error: self.errors.append(f"pageerror: {error}"))

        def on_dialog(dialog):
            self.dialogs.append(dialog.message)
            dialog.dismiss()

        page.on("dialog", on_dialog)


@contextmanager
def browser_page(width=1440, height=900):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={"width": width, "height": height}, bypass_csp=True)
        page = context.new_page()
        console = Console()
        console.attach(page)
        try:
            yield page, console
        finally:
            browser.close()


HOST_PATH = "/__ui_hunt_host"


def embed(page, query, width=1100, height=560):
    """Loads the recruiting page framed in a same-origin host page, like the chat does. Returns the Frame."""
    html = (
        "<!doctype html><html><body style='margin:0'>"
        f"<iframe id='panel' src='/recruiting?{query}' style='width:{width}px;height:{height}px;border:0;display:block'></iframe>"
        "</body></html>"
    )
    page.route(BASE + HOST_PATH, lambda route: route.fulfill(status=200, content_type="text/html", body=html))
    page.goto(BASE + HOST_PATH)
    page.wait_for_selector("#panel")
    frame = page.frame_locator("#panel")
    handle = page.query_selector("#panel").content_frame()
    handle.wait_for_load_state("load")
    return handle


def wait_board(page_or_frame, timeout=15000):
    page_or_frame.wait_for_selector("#board:not([hidden]) #nodes .node", timeout=timeout)
    page_or_frame.wait_for_timeout(1500)  # node entry transitions


class Result:
    def __init__(self, name):
        self.name = name
        self.failures = []

    def check(self, condition, message):
        print(("  ok   " if condition else "  FAIL ") + message)
        if not condition:
            self.failures.append(message)

    def finish(self, console=None, allow_console=False):
        if console is not None:
            for error in console.errors:
                print("  console error:", error)
            if not allow_console:
                self.check(not console.errors, "no console/page errors")
            self.check(not console.dialogs, f"no alert dialogs (got {console.dialogs})")
        print(f"{self.name}: {'BUG REPRODUCED' if self.failures else 'no bug'}")
        sys.exit(1 if self.failures else 0)

"""linkifyCitations() runs a regex over the sanitized HTML string, so a "[source:x]" inside an attribute
value (a link title or an image alt written by the model, or copied from retrieved text) is replaced with
'<button type="button" ...>' whose quotes close the attribute. The element gains junk attributes
(class="inline-citation", data-source-id, an attribute named 'button"'), the rest of the attribute value
spills out as page content, and the <a> itself is wired as a citation button. In browsers that serialize
'<' raw inside attribute values the spilled text is parsed as markup (script injection after DOMPurify).
The answer comes from scripted conversation history."""
import _setup  # noqa: F401
from common import *
from _chatfake3 import INIT

ANSWER = ('See [the doc](https://example.com/doc "per [source:doc-1] tail") and '
          '![chart [source:img-2] caption](https://example.com/c.png). Plain cite [source:doc-1].')
r = Result("c08 citation markup breaks out of attribute values")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""a => {
      window.__conversations = [{ conversationId: 'cA', title: 'Chat A', updatedAt: new Date().toISOString() }];
      window.__details.cA = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: a }] };
    }""", ANSWER)
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_selector(".message-row.assistant .message-text")
    report = page.evaluate("""() => {
      const root = document.querySelector('.message-row.assistant .message-text');
      const bad = [];
      for (const el of root.querySelectorAll('*')) for (const at of el.attributes) if (/["<>]/.test(at.name)) bad.push(el.tagName + '[' + at.name + ']');
      const nonButtons = [...root.querySelectorAll('.inline-citation')].filter((el) => el.tagName !== 'BUTTON').map((el) => el.tagName);
      const link = root.querySelector('a');
      return { bad, nonButtons, title: link && link.getAttribute('title'), text: root.textContent };
    }""")
    r.check(not report["bad"], f"no element gains attributes made from the citation markup (got {report['bad']})")
    r.check(not report["nonButtons"], f"only real buttons act as citations (also wired: {report['nonButtons']})")
    r.check('">' not in report["text"] and "tail" not in report["text"],
            f"the link title does not spill into the text (text: {report['text'][:160]!r}; title: {report['title']!r})")
r.finish(console, allow_console=True)

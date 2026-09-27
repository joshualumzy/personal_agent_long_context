# Browser regression checks (Playwright, Python)

Each `hNN_*.py` exits 1 when its bug comes back. They need a running server
with fictional people and roles to act on:

```bash
RECRUITING_ROLES_DIR=$(mktemp -d)/roles RECRUITING_STATE_PATH=/tmp/none.json \
EXA_API_KEY= HUNTER_API_KEY= PROSPEO_API_KEY= GOOGLE_CLIENT_ID= \
MEMORY_ADAPTER=deterministic PORT=3241 node --import tsx src/server.ts
```

Then create two confirmed roles with candidates (for example "Backend
engineer in Singapore who knows TypeScript and Node") and one unconfirmed
role through `POST /api/recruiting/roles` and `/confirm`, and run:

```bash
BASE=http://127.0.0.1:3241 ROLE_A=<confirmed> ROLE_B=<confirmed> ROLE_DRAFT=<draft> \
  python3 test/regression/ui/h03_delete_armed_carries_over.py
```

`h01` expects role A to hold a criterion with an HTML payload such as
`<img src=x onerror=alert(1)>`; `h16` deletes the role in `SACRIFICE`.
`h09` and `h23` are layout checks deferred to the UI redesign.

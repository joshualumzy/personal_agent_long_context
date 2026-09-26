# Round 4 browser checks

Seeded, model-free checks. Start a server over the seeded roles (dummy model
settings keep the recruiting routes on; nothing calls a model):

```bash
S=$(mktemp -d); python3 test/regression/ui/r4/_seed.py $S/roles
env -i PATH="$PATH" HOME="$HOME" RECRUITING_ROLES_DIR=$S/roles RECRUITING_STATE_PATH=/nonexistent/x.json \
  EXA_API_KEY= HUNTER_API_KEY= PROSPEO_API_KEY= GOOGLE_CLIENT_ID= MEMORY_ADAPTER=deterministic \
  AWS_REGION=ap-southeast-2 SOCLAAS_BASE_URL=http://127.0.0.1:9/v1 SOCLAAS_API_KEY=dummy PORT=3261 \
  node --import tsx src/server.ts
cd test/regression/ui/r4 && for f in [cr]0*.py; do BASE=http://127.0.0.1:3261 python3 $f || echo "FAILED $f"; done
```

Each check answers the action requests itself, so the seeded data does not change.

Round 5 and 6 checks in `../r5/` and `../r6/` run the same way against the same seed.

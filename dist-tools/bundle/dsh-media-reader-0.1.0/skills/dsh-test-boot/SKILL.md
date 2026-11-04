---
name: dsh-test-boot
description: Verify a DSH plugin or profile change end-to-end by booting a scratch web instance on a free port BEFORE the user restarts their real server, and LEAVE IT RUNNING for the user's own eye-check (never --no-open, never shut it down while they are looking). Use whenever a dsh plugin or cordis.patch.yml change needs a server restart, before claiming any DSH plugin works, and to recognise the "bundle script failed to load" false alarm.
---

# DSH Test-Boot Verification (before handing over a restart)

## When to use

Any change that only takes effect on server restart — plugin packages, profile
`cordis.patch.yml`, bundles — must be verified by test-booting a SECOND instance
before the user restarts their real server. Shipping a crash to the real server
costs the user a session and manual recovery (twice, for the cost-bubble); a
test boot costs ~15 seconds and catches the crash first.

## Golden rules

1. **Never `--no-open`.** Let the browser open — the user watches the scratch UI,
   sees render errors and the boot screen with their own eyes. (Explicit user
   preference, 2026-09-02.)
2. **Never touch the real server** (default port 3080). The test instance uses a
   scratch port and is killed when the test ends.
3. **Kill by PID, never `pkill -f`.** A `pkill -f "dsh web --port <port>"` pattern
   matches the test script's OWN command line (it contains that text) and kills
   the script mid-cleanup — the leftover-patch bug that happened once already.
4. **Leave the scratch instance RUNNING until the user says they are done.**
   The browser tab is part of the test. Boot it, hand over the URL, run the curl
   checks **while it stays up**, and shut down only after the user confirms what
   they saw. A fixed `sleep 12` followed by `kill` (the 2026-09-17 mistake) gives
   the user a half-loaded UI, a dead tab, and a stream of false errors to chase.
   If you must reclaim the port early, say so explicitly and tell them the tab
   will show load errors afterwards.
5. **A load error on a dead server is not a plugin failure.** The browser error
   below means the scratch server went away mid-load — verify liveness and
   re-boot before reporting any defect, and never tell the user their plugin is
   broken on the strength of a dead-server tab.

## False alarm: "Failed to load plugins … bundle script … failed to load"

Exact signature seen 2026-09-17, reported by the user as a plugin defect when the
scratch instance had already been killed:

```
Failed to load plugins
failed to import loader entry 0c74e833 (@deepseek-ai/dsh-typert-registry):
client-modules: bundle script /plugins/@deepseek-ai/dsh-typert-registry/client.js?rev=… failed to load
```

Triage — always run this before believing the error:

```bash
ps -o pid,etime,cmd -p "$(cat /tmp/dsh-test-boot.pid)"   # is the instance even alive?
ss -tuln | grep 3096                                     # is the port still bound?
```

Two tells that it is a dead-server artifact, not a defect:

- the failed package is often a **platform** package (`@deepseek-ai/…`) that the
  plugin does not own — it is simply the bundle the loader happened to fetch next;
- the same URL returns **200** from a running instance
  (`curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-typert-registry/client.js`).

Correct recovery: re-boot the scratch instance on the same port (the user's tab
then just needs a reload) and re-check it **while it runs**.

## Workflow

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
PORT=3096   # any free port; check first: ss -tuln | grep "$PORT"
            # 3080 is NOT free: it is the operator's live harness (see the map below)
setsid nohup node /usr/local/bin/dsh web --port "$PORT" > /tmp/dsh-test-boot.log 2>&1 &
echo $! > /tmp/dsh-test-boot.pid      # a later session can always kill it by PID
sleep 12
cat /tmp/dsh-test-boot.pid
```

`setsid nohup … &` keeps the instance alive after the launching command returns,
so the user can keep looking while you continue working; the PID file replaces
any temptation to use `pkill -f` (which matches the shell that runs it — three
landings recorded in `bug-census`).

## Only after a clean test

Tell the user to restart the real server:
`pkill -f "node /usr/local/bin/dsh web"` → `node /usr/local/bin/dsh web` → hard
refresh — and give them the post-restart curl checks (route + bundle). Never
instruct a restart without a green test boot first.

## Related

- `dsh-plugin-install-safety-SKILL` — split-Symbol crash guard; run its
  duplicate-package check on any plugin install.
- `dsh-token-cost-bubble` — the worked example: two crashes shipped to the
  real server (missing `./package.json` export → silent 404; missing factory
  prologue → boot-screen crash) that this test-boot + curl workflow catches.

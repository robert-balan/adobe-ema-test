What changed, and why:

Evidence it works — the tooling is what decides whether real Jira issues are correct, so a
change to it needs more than a green test run:

- [ ] `npm test` passes
- [ ] `xray-push.mjs --dry-run` against a real plan, output pasted below
- [ ] `qa-coverage.mjs --plan ...` still reports every pushed test as counted

```
paste the dry-run output here
```

If this changes the agent's doctrine rather than the scripts, say which rule changed and what
went wrong that prompted it. The rules in `.claude/agents/qa-xray.md` carry their reasons for
exactly this purpose.

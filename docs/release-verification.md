# Release Verification

This checklist separates package creation, authentication, publication, and real consumer installation. Passing an earlier step never proves a later step.

## npm release gate

```text
npm pack --dry-run
      |
      v
npm whoami
      |
      v
npm publish
      |
      v
registry lookup of the published version
      |
      v
real `npx --yes @tian/agent-workflow@<version>` installation and command smoke test
```

Required reporting:

- `npm pack --dry-run` proves only that the local package can be assembled.
- `npm ping` proves registry connectivity, not publication permission.
- `npm whoami` must succeed before claiming authenticated publication readiness.
- A failed publish, `ENEEDAUTH`, missing registry version, or failed real `npx` install is an incomplete release.
- A drafted commit message is not a commit; a staged diff is not a published release.

## Runtime synchronization gate

For local runtime changes, run the current Node bundle's `Repair`, then `Verify`, and inspect the installed managed state. Keep migration backups and confirm the installed hooks point to the intended Node bundle. Repository source, installed runtime, and remote npm package are separate evidence layers.

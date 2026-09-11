# Initial sync checkpoints

## Decision

Initial server-authoritative and local-import runs persist a per-path checkpoint
after every verified download, upload, conflict preservation, or deletion.

## Behaviour

- A retry reuses the checkpoint and validates each completed path by its current
  SHA-256 digest, so an unrelated manifest revision does not force a replay.
- A file whose local bytes already match the server digest is recorded as
  complete without downloading it again.
- The ordinary sync baseline and `initialSyncCompleted` flag are written only
  after the complete initial pass succeeds.
- An interrupted pass leaves its transaction in local storage for the next run;
  it is cleared only after the final baseline is saved.

This prevents a partial first sync from repeatedly overwriting the same files
and makes the “initial sync” state truthful after a restart.

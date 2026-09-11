# Control-centre account actions and initial-sync performance

## Control centre

Device management is a recurring account operation, so it lives only in the
NAS Vault ribbon control centre. The page presents an active-device count and a
Manage devices modal containing last-seen data and revoke actions. Connection
health is checked from the status card; the settings page no longer duplicates
either action.

## After first setup

The first-sync choice remains a one-time server-authoritative or local-import
decision. Once the baseline is complete, the page exposes ordinary Sync now;
future authority-changing resets must be separate, clearly labelled,
confirmation-gated actions rather than reusing “Set up vault sync”. If a first
sync is interrupted, the control centre now says “Initial sync paused” and
resumes the saved checkpoint with the original direction; it does not ask the
user to choose the authority direction again.

## Performance

Initial server downloads use three bounded concurrent workers. Each file is
still digest-verified and checkpointed independently, so interruption and
retry semantics remain unchanged while avoiding a strictly serial request
queue. A future transfer meter should report verified bytes, current file,
throughput, and ETA without changing the concurrency safety limit.

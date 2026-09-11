# NAS Vault

Copyright (C) 2026 Mateo

NAS Vault (mynasbridge) is an open-source Obsidian plugin for connecting
Obsidian to a self-hosted NAS. It provides a NAS overview, calendar and
server-routed daily-note workflow, and an optional private vault-sync client.

## Current release

Version 0.6.3 is a sync-integrity release built on the 0.6.2 privacy-cleanup
release and the 0.6.1 unified NAS-base-URL architecture. The plugin requires a compatible
self-hosted NAS API and private network; this repository contains the Obsidian
client only. The server, enrollment service, VPN, and hosting infrastructure
are separate components.

## Features

- NAS overview with authenticated calendar and vault-sync connection checks.
- One private NAS base URL for calendar, vault-sync, and enrollment gateway
  routes; older service-specific URL settings migrate automatically.
- One Connect to NAS flow for registration or account sign-in. After password
  and email verification, it authorizes the selected device and performs the
  opted-in initial sync; calendar and internal resource identifiers remain
  server-owned.
- One local device credential, never displayed or written to vault files.
- Foreground connection checks when Obsidian opens or resumes; optional
  conflict-preserving sync after an explicit single-writer cutover.
- Calendar browsing, event creation/editing, recurrence, reminders, attendees,
  and server-routed daily-note creation.
- SHA-256 inventory and device-local three-way vault reconciliation.
- Conditional writes, resumable uploads, ranged downloads, and digest
  verification before replacing a downloaded file.
- Server-revision preconditions, immutable per-file history, rename lineage,
  30-day deleted-file quarantine/restore, and account export/import (provided by
  the companion NAS API).
- Control-centre conflict comparison/resolution, revision-history downloads,
  and binary-safe keep-local/keep-server/keep-both choices.
- Initial server-authoritative setup that preserves local differences as
  conflict copies.
- Optional foreground synchronization, disabled by default.

The sync scope excludes Obsidian workspace/cache state, Git metadata, and
generated conflict copies. Mobile background execution is not guaranteed.
Synchronization is not a backup.

## Requirements and safety

- Obsidian 1.3.0 or later.
- A compatible, privately reachable NAS API and a device-scoped credential.
- A private network path such as a self-hosted VPN or Tailscale.

The plugin does not install or configure a VPN, grant SSH access, or provide a
hosted service. Device credentials are stored locally and are never written to
vault files. Do not run this plugin and another synchronization engine as
concurrent writers for the same vault.

## Installation

After Community Plugins approval, install NAS Vault from Obsidian's Community
Plugins browser. For testing before or outside the directory, download
main.js, manifest.json, and styles.css from a GitHub release and place them in
.obsidian/plugins/mynasbridge/.

## Development

Requirements: Node.js 22 or later.

    npm ci
    npm test
    npm run build

Edit files in src/. main.js is generated and included in tagged releases; the
release workflow also attaches the Obsidian runtime files automatically.

The first mynasbridge launch migrates compatible settings from the former
nas-calendar-bridge development installation when that legacy data is
available. Device credentials and sync baselines are scoped to this local vault
installation and never written to vault files.

## License

This project is licensed under the GNU General Public License version 3 or any
later version. See LICENSE.

No passwords, access tokens, vault contents, addresses, or personal server
configuration belong in this repository.

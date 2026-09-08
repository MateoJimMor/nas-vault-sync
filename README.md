# NAS Vault

> Private development repository — not ready for a Community Plugin release or
> use against a real vault.

NAS Vault is an Obsidian plugin under development for a self-hosted vault and
calendar service. Its vault-sync client is designed to work on desktop, iOS,
and Android through a compatible private server API.

## What the plugin currently does

- Calculates a SHA-256 inventory of eligible vault files.
- Uses a device-local base manifest for three-way reconciliation.
- Transfers one-sided changes and preserves concurrent edits as conflict copies
  rather than overwriting them silently.
- Uses conditional requests, resumable uploads, ranged downloads, and digest
  verification before replacing a downloaded file.
- Keeps automatic foreground sync opt-in and off by default.

The plugin excludes Obsidian workspace/cache state, Git metadata, and generated
conflict copies from synchronization. It does **not** promise unrestricted
background synchronization on mobile devices.

## Important limitations

This repository intentionally contains only the Obsidian client. It does not
ship a server, a hosted service, a device-pairing service, a VPN, or a way to
install Tailscale automatically. A user needs a compatible, privately reachable
server and a device-specific credential before sync can be configured.

Do not use two synchronization engines as writers for the same vault. Test with
a disposable vault and complete the server-authoritative initial sync before
enabling ordinary two-way synchronization.

## Development

Requirements: Node.js 22 or later.

```sh
npm ci
npm test
npm run build
```

Edit files in `src/`. `main.js` is generated and deliberately excluded from
Git; a future release workflow will build and attach `main.js`, `manifest.json`,
and `styles.css` to each Obsidian-compatible GitHub release.

## Release status

The current plugin ID and internal version are retained temporarily so this
repository stays aligned with the active development build. Before any public
release, the project needs a final permanent plugin ID, public setup
documentation, a license, physical device acceptance testing, and a generic
server deployment path.

No passwords, access tokens, vault contents, addresses, or personal server
configuration belong in this repository.

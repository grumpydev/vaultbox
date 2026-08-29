# Vaultbox Privacy Policy

Last updated: 2026-06-21

Vaultbox is an Obsidian plugin that syncs an Obsidian vault directly with a Dropbox folder selected by the user. Vaultbox runs inside Obsidian on the user's device. It does not use a separate Vaultbox server.

## Summary

Vaultbox uses the Dropbox API only to let the user connect Dropbox, choose a Dropbox folder, compare that folder with the local Obsidian vault, and sync file changes between the two locations.

Vaultbox does not sell personal data, does not run advertising, does not use analytics, and does not send vault contents to the developer.

## Dropbox API Use

Vaultbox uses Dropbox OAuth with PKCE to connect to the user's Dropbox account. The plugin requests these Dropbox scopes:

- `files.metadata.read`
- `files.content.read`
- `files.content.write`

Vaultbox uses these permissions to:

- list Dropbox folders so the user can choose a sync folder;
- list file metadata in the selected Dropbox folder;
- download Dropbox files that need to be synced into the local Obsidian vault;
- upload local Obsidian files that need to be synced to Dropbox;
- create Dropbox folders needed for uploaded files;
- delete Dropbox files when a sync plan determines that a local deletion should be mirrored remotely;
- read Dropbox file revisions and hashes to avoid overwriting changed files unexpectedly.

The Dropbox app uses Full Dropbox access because Vaultbox is designed to sync with an existing Dropbox folder chosen by the user, including folders already managed by the Dropbox desktop app. Vaultbox's sync logic only operates inside the Dropbox folder selected in Vaultbox settings.

## Information Stored Locally

Vaultbox stores plugin data locally in Obsidian's plugin data storage. This can include:

- Dropbox OAuth access and refresh tokens;
- the selected Dropbox folder path;
- sync metadata such as file paths, content hashes, Dropbox revisions, and timestamps;
- user settings such as sync mode and debug logging preference;
- a small rolling debug log when debug logging is enabled.

Debug logs are intended for troubleshooting. Vaultbox redacts token-like fields before writing debug log entries, but users should still review logs before sharing them publicly because logs may include file paths or sync status details.

## Obsidian Vault Contents

Vaultbox reads local Obsidian files so it can compare them with Dropbox and sync changes. Vaultbox may upload, download, modify, or delete files as part of the sync plan shown or executed by the user.

Vaultbox excludes Obsidian's configuration folder and hidden directories from sync by default. Users may explicitly enable synchronization of the community plugin ID list, themes, CSS snippets, or selected top-level hidden directories.

Configuration synchronization uses a narrow allowlist. Vaultbox does not sync community plugin binaries, plugin `data.json` files, workspace state, or Vaultbox's locally stored Dropbox tokens.

## Information Shared With Third Parties

Vaultbox communicates with Dropbox using Dropbox's API. File metadata and file contents needed for sync are sent to Dropbox or received from Dropbox according to the user's sync actions.

Vaultbox does not send vault data, Dropbox tokens, or usage analytics to the developer.

Vaultbox runs inside Obsidian, so use of the plugin also depends on Obsidian's own application behavior and privacy practices.

## Data Retention And Deletion

Vaultbox's local plugin data remains on the user's device until the user clears it, uninstalls the plugin, deletes the vault, or otherwise removes Obsidian plugin data.

Files synced to Dropbox remain in the user's Dropbox account until the user deletes them or a Vaultbox sync operation deletes them according to the sync plan.

Users can revoke Vaultbox's Dropbox access from their Dropbox account settings. Revoking access prevents future Dropbox API calls, but does not automatically delete files already present in Dropbox or local plugin data already stored in Obsidian.

## Security

Vaultbox uses Dropbox OAuth with PKCE and does not store a Dropbox app secret in the plugin. Dropbox tokens are stored locally in Obsidian plugin data. Users should protect access to their device, vault, and Obsidian configuration folder.

## Changes To This Policy

This policy may be updated when Vaultbox's behavior changes. The current policy is published in the Vaultbox repository.

## Contact

For privacy questions or support, open an issue at:

https://github.com/grumpydev/vaultbox/issues

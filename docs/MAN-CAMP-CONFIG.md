# Man Camp Configuration

This document summarizes the Phase 1 configuration model for the Man Camp migration.

The goal of Phase 1 is to centralize global event naming, metadata, and lodging constants in `Config.gs` without changing the underlying architecture yet.

## Primary Config Areas

## `CONFIG.system`

System-wide labels used for menus, admin chrome, and health checks.

Key fields:

- `appName`
- `menuTitle`
- `adminPanelTitle`
- `adminPanelSub`
- `healthCheckName`
- `organizationName`
- `registrationLabel`
- `attendeeGroupLabel`
- `contactLabel`

Operator TODO:

- Set `organizationName` to the real conference / ministry name.
- Update `adminPanelSub` if you want the sidebar subtitle to show final event details instead of placeholder text.

## `CONFIG.event`

Top-level event metadata for Man Camp.

Key fields:

- `code`
- `year`
- `name`
- `tagline`
- `dates`
- `location`
- `contactName`

Operator TODO:

- Replace all placeholder values before production deployment.

## `CONFIG.email`

Outbound email metadata and contact values.

Key fields:

- `enabled`
- `fromName`
- `fromEmail`
- `replyTo`
- `subject`
- `eventName`
- `eventDates`
- `eventLocation`
- `contactEmail`
- `contactPhone`

Operator TODO:

- Replace all `TODO:` placeholder sender and contact values.

Notes:

- Gmail still sends from the Google account that deployed the Apps Script project.
- `fromName` and `replyTo` control the visible branding and reply behavior.

## `CONFIG.pdf`

PDF naming and batch messaging.

Key fields:

- `folderName`
- `batchDialogLabel`
- `batchCompleteSubject`

Current default folder:

- `Man Camp Registration PDFs`

## `CONFIG.lodging`

Centralized lodging constants added in Phase 1.

### `CONFIG.lodging.capacities`

- `cabinNoBathBottomBunks: 90`
- `cabinBathBottomBunks: 33`
- `rvSpots: 0`
- `tentUnlimited: true`

### `CONFIG.lodging.categories`

Defined categories:

- `cabinNoBath`
- `cabinBath`
- `rv`
- `tent`

Each category includes:

- a stable `key`
- a human-readable `label`
- an `inventoryType`
- a `publicCapacity`
- whether it `countsAsUnlimited`

### `CONFIG.lodging.validation`

These flags document and now drive the core Man Camp lodging rules.

Current flags:

- `onlyBottomBunksCountTowardPublicCapacity`
- `childTopBunksRequireGuardian`
- `childWithoutGuardianGetsAutoBunk`
- `waitlistWhenBottomBunksExhausted`
- `adultsConsumeBottomBunkInventory`
- `guardiansConsumeBottomBunkInventory`

Phase 3 uses these flags as the canonical rules source for inventory and bunk assignment helpers in `Lodging.gs`.

## Phase 3 Inventory Model

The inventory engine now creates and maintains:

- `LodgingInventory`
- `LodgingAssignments`

Assignment behavior:

- adults and guardians requesting cabins consume bottom-bunk inventory
- linked children requesting cabins can receive `top_guardian_child`
- top bunks are tracked separately and do not consume public capacity
- children without a guardian link are set to `manual_review`
- RV selections consume configurable RV spot capacity
- tent selections are always assignable because tent inventory is unlimited

The inventory summary is rebuilt from `LodgingAssignments`, not from hidden counters.

## Backward Compatibility Notes

Phase 1 intentionally preserves the current sheet names and most internal keys:

- `club_name`, `director_email`, and similar existing data keys still exist in the runtime code
- report and PDF entry points still preserve some legacy function names for compatibility, but the active outputs are now Man Camp-oriented
- global branding and metadata now read as Man Camp where practical

This means the repo is still mixed in its internal compatibility layer, but the active registration, lodging, admin, reporting, email, and check-in flows are now Man Camp-oriented.

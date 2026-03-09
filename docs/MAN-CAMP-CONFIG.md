# Man Camp 2026 Configuration

`Config.gs` is now the canonical source for finalized Man Camp 2026 business rules.

## Event metadata

- Event: `Man Camp 2026`
- Theme: `Shields of Faith`
- Theme reference: `Ephesians 6:16`
- Speakers:
  - Lee Rochholz — Iowa Missouri Conference President
  - Mike Fenton — Senior Pastor, Chapel Oaks Seventh-day Adventist Church

## Registration options

`CONFIG.registrationOptions` centralizes:

- stable option key
- public label
- description
- fixed price
- attendance type
- lodging type
- inventory category
- waitlist behavior

## Lodging inventory

`CONFIG.lodging` now uses finalized Man Camp labels and keys:

- `shared_cabin_connected`
- `shared_cabin_detached`
- `rv_hookups`
- `tent_no_hookups`
- `sabbath_attendance_only`

Inventory rules:

- Shared cabin connected uses connected-restroom cabin inventory.
- Shared cabin detached uses detached-restroom/shower cabin inventory.
- RV uses configurable RV hookup inventory.
- Tent is unlimited unless staff later add a cap.
- Sabbath Attendance only never consumes overnight inventory.
- Cabin public inventory is still bottom-bunk based.
- Guardian-linked minors can use `top_guardian_child` cabin placement without consuming additional public bottom-bunk inventory.

## Shirt inventory

`CONFIG.shirts.sizes`:

- `M: 20`
- `L: 35`
- `XL: 31`
- `2XL: 5`
- `3XL: 5`
- `4XL: 4`

Shirt inventory is recalculated from accepted roster rows and written to the `ShirtInventory` sheet.

## Program and age rules

`CONFIG.programs`:

- `standard`
- `young_mens`

Young Men's rules:

- ages `10-14` only
- guardian information required

`CONFIG.ageRules`:

- minors are under `18`

## Payment handling

`CONFIG.payments` documents the accepted inbound payment statuses and the default method label:

- Fluent Forms + Square remain the payment processor
- Apps Script preserves selected price and charged totals for reconciliation
- backend inventory and validation still run after submission

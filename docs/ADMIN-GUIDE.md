# Admin Guide

This guide covers the Google Sheets admin workflow for the **Man Camp Registration System**.

## Admin Sidebar

Open the sidebar from **Man Camp System → Admin Tools → Open Admin Sidebar**.

The sidebar is now lodging-first. Staff should use it in this order:

1. Review the **Lodging Dashboard** on the search screen.
2. Search by person name, registration ID, email, or phone.
3. Open a registration to review lodging status, guardian links, and bunk assignments.
4. Use **Manual Lodging Update** only when staff need to override the automatic assignment rules.

## Search Screen

The search screen now supports:

- registration ID
- primary contact name
- attendee name
- email
- phone

The search screen also shows a live **Lodging Dashboard** with:

- Cabin No Bath used / remaining
- Cabin With Bath used / remaining
- RV used / remaining
- Tent assignment count
- child-without-guardian count
- waitlisted cabin request count
- invalid lodging choice count

The dashboard includes a short **Priority Queue** so staff can jump directly into flagged registrations.

## Registration Details

Opening a registration shows:

- registration label and registration ID
- primary contact email and phone
- lodging preference
- lodging status
- assigned lodging area
- bunk type summary
- counts for adults, guardians, children, and waitlisted people
- per-person roster rows with guardian linkage, bunk type, and lodging status

### Attention Flags

The detail view flags these conditions:

- child without guardian
- waitlisted cabin request
- invalid lodging choice
- manual review required

## Manual Lodging Update

The detail view includes a **Manual Lodging Update** section.

Staff can update:

- registration lodging status
- assigned lodging area
- registration notes
- each attendee’s lodging status
- each attendee’s bunk type
- each attendee’s assigned area
- guardian link key
- guardian registration ID
- per-attendee notes

After saving:

- `Registrations` is updated
- `Roster` is updated
- `LodgingAssignments` is rewritten for that registration
- `LodgingInventory` is recalculated
- summary rows in legacy assignment/camping sheets are refreshed

### Important limitation

Manual overrides are explicit sheet updates. Later roster mutations that trigger a fresh lodging rebuild may replace those overrides with rule-based results. If staff are making a special exception, they should confirm the final saved result after any add/remove action.

## Add Person

The **Add Person** panel supports:

- full name
- age group
- age
- email
- phone
- lodging preference
- guardian link key
- guardian registration ID
- guardian checkbox
- notes / dietary field

When a person is added:

- a roster row is appended
- registration snapshots are refreshed
- lodging inventory is recalculated using the current business rules

## Remove Person

The **Remove Person** panel removes one attendee at a time.

When a person is removed:

- the roster row is deleted
- registration totals are refreshed
- lodging assignments are rebuilt
- inventory totals are recalculated

## Lodging Queue

The **Lodging Queue** is the sidebar replacement for the old assignment manager.

It shows registrations grouped by effective status:

- pending
- needs review
- assigned

Use it to find registrations that still need manual follow-up, then open the registration detail view to make updates.

## Other Sidebar Actions

These older tools remain available where still compatible:

- resend confirmation email
- generate/view PDF
- individual attendee check-in
- update estimated total
- revoke meal discount
- delete registration
- validate data integrity
- find duplicates

## Inventory Model

Inventory is driven by `LodgingAssignments` and summarized in `LodgingInventory`.

Rules enforced by the system:

- adults and guardians consume bottom-bunk inventory
- linked children may use top bunks
- top bunks do not reduce public bottom-bunk capacity
- children without a guardian link are flagged for manual review
- RV capacity comes from `Config.gs`
- tents are unlimited

## Recommended Staff Workflow

1. Start on the search screen and review the dashboard counts.
2. Open items from the priority queue first.
3. In the registration detail screen, use the **On-Site Check-In** section to check in each eligible attendee individually.
4. Resolve guardian-link issues before trying to clear cabin waitlists.
5. Use manual overrides only when the automatic assignment result is not the final staff decision.
6. Re-open the registration after any edit to confirm the saved lodging state.

## On-Site Check-In

Check-in now happens at the attendee level.

Volunteers can search by:

- registration ID
- attendee name
- primary contact name
- email
- phone

Inside a registration detail view, the **On-Site Check-In** section shows each attendee with:

- attendee name
- lodging preference
- lodging status
- bunk type
- assigned lodging area
- guardian/link context
- notes and flags when relevant

Check-in rules:

- attendees already marked `Arrived` cannot be checked in again
- attendees with `waitlist` status are blocked from check-in as assigned
- attendees with `manual_review` status are blocked until staff resolve their lodging
- registration-level check-in status is updated automatically as a rollup

## TODO / Advanced Features

The current admin migration intentionally leaves these advanced features for a later phase:

- bed-by-bed cabin mapping
- cabin/area picklists instead of free-text area entry
- dedicated manual-override locking so rebuilds cannot replace staff exceptions
- richer lodging audit history in the sidebar UI

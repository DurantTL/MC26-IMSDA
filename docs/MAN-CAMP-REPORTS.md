# Man Camp Reports and PDF Cleanup

This document summarizes the reporting/export cleanup completed during the Man Camp migration.

## Active Reports

The active Google Sheets report set is now lodging-first:

- `Registration Dashboard`
- `Lodging Inventory Summary`
- `Assigned vs Waitlisted`
- `Guardian Child Pairing`
- `RV and Tent Counts`

These reports are generated from the current `Registrations`, `Roster`, `LodgingInventory`, and `LodgingAssignments` sheets.

## What Was Removed or Deprecated

The following legacy report behaviors were intentionally removed from the active reporting flow:

- club-by-club dashboard organized around Pathfinder/TLT/staff roles
- camping coordinator summary based on tents, trailers, canopy size, square footage, and `camp_next_to`
- duty/activity preference reporting
- legacy test-report generator data

The old entry-point function names still exist where needed for compatibility:

- `generateClubDashboardSheet()` now generates `Registration Dashboard`
- `generateCampingCoordinatorSheet()` now generates `Lodging Inventory Summary`

## PDF Changes

PDF generation still exists, but it now produces a registration summary instead of a club packet.

Current PDF contents:

- registration ID and primary contact
- attendee list
- lodging preference, status, bunk type, and assigned area
- guardian-child linkage summary
- staff-facing flags such as waitlist/manual-review conditions

Dropped from PDFs:

- club packet layout
- duty preferences
- special activities
- campsite logistics blocks
- program-specific sections (no longer applicable)

## Intentional Compatibility Gaps

Some legacy sheet columns still exist because the migration has been staged for safety:

- `club_name`
- `director_email`
- `roster_json`
- legacy role columns

Those columns are no longer the source of truth for reports.

## Operator Notes

- Use `Generate ALL Reports` after manual lodging edits if you want the summary sheets refreshed immediately.
- Use the PDF menu only for attendee/registration summaries; it does not generate club packet exports.
- If you still need a legacy report for archive reasons, keep an older export outside this repo. The active code no longer regenerates those outputs.

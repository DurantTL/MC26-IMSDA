# Data Model & Sheet Schemas

The Man Camp Phase 2 migration changes the registration model from club-based registration to person-based registration.

The current implementation keeps the existing sheet names for compatibility, but the canonical registration meaning is now:

- one `Registrations` row per submitted registration or household-style submission
- one `Roster` row per individual attendee/person
- one `CampingGroups` row per registration, reused as a temporary lodging-summary table
- one `Assignments` row per registration, reused as a temporary lodging-assignment placeholder table
- one `LodgingInventory` row per lodging category, rebuilt from assignment data
- one `LodgingAssignments` row per attendee assignment for auditability

All column access in the code uses dynamic header-name mapping where practical, so new fields can be appended without breaking older sheets.

---

## Sheet Overview

| Sheet | Purpose | Populated by |
|---|---|---|
| `RAW` | Raw webhook payloads and normalized payload snapshots | `Code.gs: writeRawRow_()` |
| `Registrations` | One row per registration submission | `Registration.gs` |
| `Roster` | One row per person/attendee | `Registration.gs` |
| `CampingGroups` | Legacy-named compatibility sheet carrying lodging summary per registration | `Registration.gs` |
| `Assignments` | Legacy-named compatibility sheet carrying admin/lodging summary fields per registration | `Registration.gs` |
| `LodgingInventory` | Inventory summary by lodging category | `Lodging.gs` |
| `LodgingAssignments` | One row per person-level lodging assignment | `Lodging.gs` |
| `EmailLog` | Email send history | `Email.gs` |

---

## Canonical Person-Based Fields

The following fields are now the canonical minimum model for an attendee/registration record:

| Field | Meaning |
|---|---|
| `registration_id` | Registration identifier |
| `first_name` | Person first name |
| `last_name` | Person last name |
| `email` | Contact email |
| `phone` | Contact phone |
| `age_group` | `adult` or `child` |
| `is_guardian` | Whether this person is a guardian |
| `guardian_registration_id` | Optional cross-registration guardian reference |
| `guardian_link_key` | Optional linkage key inside or across submissions |
| `lodging_preference` | `cabin_no_bath`, `cabin_bath`, `rv`, or `tent` |
| `lodging_status` | `assigned`, `waitlist`, `pending`, or `manual_review` |
| `bunk_type` | `bottom`, `top_guardian_child`, `rv`, `tent`, or `none` |
| `assigned_lodging_area` | Cabin/site/area placeholder |
| `notes` | Free-text notes |
| `created_at` | Record creation time |

These fields are present in the active schema even when legacy compatibility columns still exist.

---

## Inventory Rules

The lodging engine now enforces these rules during registration processing and registration rebuilds:

- `cabin_no_bath`: 90 public bottom bunks
- `cabin_bath`: 33 public bottom bunks
- `rv`: configurable count from `Config.gs`
- `tent`: unlimited
- Adults and guardians consume bottom-bunk inventory for cabin registrations.
- Linked children may be assigned `top_guardian_child`.
- Top bunks do not reduce public bottom-bunk inventory.
- Children without a guardian link are set to `manual_review` for cabin lodging.
- RV selections with zero configured RV spots are set to `waitlist`.
- Unknown lodging options are set to `manual_review`.

---

## RAW Sheet

The RAW sheet still preserves the original webhook body for audit/replay, but now also stores normalized person/lodging snapshots.

| Header | Description |
|---|---|
| `timestamp` | Webhook receipt time |
| `entry_id` | Fluent Forms entry ID |
| `club_name` | Legacy compatibility field; currently stores a registration label when available |
| `director_name` | Legacy compatibility field; currently stores the primary contact name |
| `email` | Primary contact email |
| `phone` | Primary contact phone |
| `roster_json` | Legacy attendee snapshot |
| `camping_json` | Legacy camping snapshot or lodging summary |
| `processed` | `TRUE` when the row has been processed |
| `payload_json` | Full raw request body |
| `primary_contact_name` | Normalized primary contact name |
| `primary_contact_email` | Normalized primary contact email |
| `party_json` | Normalized people array |
| `lodging_json` | Normalized lodging request summary |

---

## Registrations Sheet

One row per submitted registration.

### Canonical meaning

This is the top-level registration record for one individual registration or one guardian-led household submission.

### Compatibility note

Legacy columns such as `club_name`, `registrant_name`, and `total_staff` are still populated so existing code paths continue to run during the migration.

### Key columns

| Header | Description |
|---|---|
| `timestamp` | Registration timestamp |
| `registration_id` | Unique registration ID |
| `registrant_name` | Legacy compatibility field for the primary contact full name |
| `registrant_email` | Legacy compatibility field for the primary contact email |
| `registrant_phone` | Legacy compatibility field for the primary contact phone |
| `club_name` | Legacy compatibility field; currently used as a registration label, e.g. household label |
| `church_name` | Optional church field if still supplied |
| `total_staff` | Adult count mapped into a legacy column |
| `total_children` | Child count |
| `total_attendees` | Total people in the registration |
| `estimated_total` | Current cost estimate |
| `late_fee_applied` | Late-fee flag |
| `roster_json` | Full normalized people array |
| `fluent_form_entry_id` | Idempotency key |
| `first_name` | Primary contact first name |
| `last_name` | Primary contact last name |
| `email` | Primary contact email |
| `phone` | Primary contact phone |
| `age_group` | Primary contact age group |
| `is_guardian` | Primary contact guardian flag |
| `guardian_registration_id` | Primary contact guardian registration reference if any |
| `guardian_link_key` | Primary contact guardian link key if any |
| `lodging_preference` | Registration-level lodging preference |
| `lodging_status` | Registration-level derived lodging status |
| `bunk_type` | Registration-level bunk summary |
| `assigned_lodging_area` | Cabin/site placeholder |
| `notes` | Registration notes |
| `created_at` | Record creation time |
| `registration_json` | Compact normalized registration summary |

---

## Roster Sheet

One row per person/attendee. This is the canonical per-person table for the new model.

### Key columns

| Header | Description |
|---|---|
| `registration_id` | FK → Registrations.registration_id |
| `attendee_id` | Person identifier |
| `attendee_name` | Full display name |
| `age` | Numeric age if provided |
| `gender` | Gender |
| `role` | Legacy compatibility role; adults are currently mapped to `staff`, children to `child` |
| `participation_status` | Legacy compatibility status |
| `dietary_restrictions` | Dietary restrictions |
| `counts_toward_billing` | `Yes` for adults, `No` for children |
| `club_name` | Legacy compatibility label; stores the registration label |
| `registrant_email` | Primary contact email |
| `timestamp` | Registration timestamp |
| `first_name` | Person first name |
| `last_name` | Person last name |
| `email` | Person email or fallback contact email |
| `phone` | Person phone or fallback contact phone |
| `age_group` | `adult` or `child` |
| `is_guardian` | `Yes`/`No` |
| `guardian_registration_id` | Optional guardian registration reference |
| `guardian_link_key` | Optional guardian linkage key |
| `lodging_preference` | Person-level or inherited lodging preference |
| `lodging_status` | `assigned`, `waitlist`, `pending`, or `manual_review` |
| `bunk_type` | `bottom`, `top_guardian_child`, `rv`, `tent`, or `none` |
| `assigned_lodging_area` | Cabin/site/area placeholder |
| `notes` | Free-text notes |
| `created_at` | Record creation time |

### Business rule note

Children without `guardian_registration_id` or `guardian_link_key` are currently flagged as `manual_review` rather than being auto-assigned lodging.

---

## CampingGroups Sheet

The sheet name is legacy. It is currently reused as a lodging-summary compatibility table per registration.

### Legacy columns still present

- `registration_id`
- `club_name`
- `tents`
- `trailer`
- `kitchen_canopy`
- `total_sqft`
- `camp_next_to`
- `pathfinder_count`
- `tlt_count`
- `staff_count`
- `child_count`
- `total_headcount`
- `timestamp`

### New appended columns

| Header | Description |
|---|---|
| `lodging_preference` | Registration-level lodging preference |
| `lodging_status` | Registration-level lodging status |
| `bunk_type_summary` | Summary of bunk types in the registration |
| `assigned_lodging_area` | Assigned lodging placeholder |
| `notes` | Notes |
| `adult_count` | Adult count |
| `guardian_count` | Guardian count |

### Mapping note

This sheet is no longer the canonical source for logistics. It now exists only as a compatibility table carrying lodging-summary data.

---

## Assignments Sheet

The sheet name is legacy. In Phase 2 it remains one row per registration and acts as a temporary placeholder for lodging/admin assignments.

### Legacy columns still present

- `registration_id`
- `club_name`
- `director_email`
- `duty_assigned`
- `duty_time_day`
- `special_activity_assigned`
- `activity_detail`
- `camping_location`
- `camping_notes`
- `email_2_sent`

### New appended columns

| Header | Description |
|---|---|
| `lodging_preference` | Registration-level lodging preference |
| `lodging_status` | Registration-level lodging status |
| `bunk_type_summary` | Summary of bunk types |
| `assigned_lodging_area` | Lodging placeholder |
| `guardian_link_key` | Guardian-link summary |
| `notes` | Notes |
| `created_at` | Row creation time |

---

## LodgingInventory Sheet

This sheet is the public inventory summary and is rebuilt from `LodgingAssignments`.

| Header | Description |
|---|---|
| `lodging_category` | `cabin_no_bath`, `cabin_bath`, `rv`, or `tent` |
| `label` | Human-readable category label |
| `inventory_type` | `bottom_bunk`, `rv_spot`, or `tent` |
| `public_capacity` | Public inventory for the category |
| `assigned_public_units` | Bottom bunks or RV spots currently consumed |
| `assigned_top_bunks` | Top bunks assigned to linked children |
| `waitlist_count` | Count of waitlisted attendees/records |
| `manual_review_count` | Count of manual-review attendees/records |
| `remaining_public_capacity` | Remaining public capacity |
| `is_unlimited` | `Yes` for tent, `No` otherwise |
| `last_recalculated_at` | Last rebuild timestamp |
| `notes` | Optional notes |

### Audit note

Only `assigned_public_units` affect public capacity. `assigned_top_bunks` are tracked separately and never reduce cabin bottom-bunk availability.

---

## LodgingAssignments Sheet

This sheet is the canonical audit log for person-level lodging outcomes.

| Header | Description |
|---|---|
| `registration_id` | FK → Registrations.registration_id |
| `attendee_id` | FK-like link to Roster attendee/person ID |
| `full_name` | Person full name |
| `age_group` | `adult` or `child` |
| `is_guardian` | `Yes`/`No` |
| `guardian_link_key` | Guardian-link key |
| `guardian_registration_id` | Cross-registration guardian reference if used |
| `lodging_preference` | Requested lodging category |
| `lodging_status` | `assigned`, `waitlist`, `pending`, or `manual_review` |
| `bunk_type` | `bottom`, `top_guardian_child`, `rv`, `tent`, or `none` |
| `assigned_lodging_area` | Cabin/site placeholder |
| `inventory_category` | Inventory category used for counting |
| `consumes_public_inventory` | `Yes` only when this row consumes bottom-bunk or RV public inventory |
| `assignment_reason` | Deterministic explanation of the outcome |
| `created_at` | Creation timestamp |
| `updated_at` | Last update timestamp |
| `check_in_status` | Individual arrival state (`Arrived` when checked in) |
| `check_in_timestamp` | Individual check-in timestamp |

---

## EmailLog Sheet

No schema change in Phase 2.

| Header | Description |
|---|---|
| `timestamp` | Email attempt time |
| `registration_id` | FK → Registrations.registration_id |
| `email` | Recipient email |
| `club_name` | Legacy label column; currently stores the registration label |
| `status` | Email status |
| `error_message` | Error details if any |

---

## Check-In Columns

### Registrations sheet

Registration-level check-in fields are now rollups derived from attendee arrivals:

| Header | Description |
|---|---|
| `check_in_status` | Summary status (`Arrived`, `Partially Arrived`, or blank) |
| `check_in_timestamp` | Latest attendee check-in timestamp for the registration |

### Roster sheet

These are now the canonical check-in fields:

| Header | Description |
|---|---|
| `check_in_status` | Individual arrival state (`Arrived` or blank) |
| `check_in_timestamp` | Individual check-in timestamp |

### LodgingAssignments sheet

These fields mirror roster check-in state for auditability:

| Header | Description |
|---|---|
| `check_in_status` | Mirrored attendee arrival state |
| `check_in_timestamp` | Mirrored attendee check-in timestamp |

---

## Legacy Field Status

### Deprecated conceptually, retained physically for compatibility

- `club_name`
- `director_email`
- `registrant_name`
- `total_pathfinders`
- `total_tlt`
- camporee duty/activity fields
- camping logistics fields like `tents`, `camp_next_to`

### Canonical going forward

- `first_name`
- `last_name`
- `email`
- `phone`
- `age_group`
- `is_guardian`
- `guardian_registration_id`
- `guardian_link_key`
- `lodging_preference`
- `lodging_status`
- `bunk_type`
- `assigned_lodging_area`
- `notes`
- `created_at`

---

## Column Mapping

Dynamic column lookup remains the preferred access pattern.

As long as header names are preserved, columns can be reordered or appended without rewriting every consumer.

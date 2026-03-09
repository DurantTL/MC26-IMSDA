# Man Camp Migration Plan

## Scope

This plan is based on direct inspection of the current repository:

- Google Apps Script backend: `Code.gs`, `Config.gs`, `Registration.gs`, `Utilities.gs`, `Email.gs`, `Reports.gs`, `CheckIn.gs`, `BackgroundJobs.gs`, `Admin.gs`, `generateRegistrationPDF.gs`
- Google Sheets admin UI: `AdminSidebar.html`
- WordPress bridge: `ManCampRegistration/man-camp-registration.php`, `ManCampRegistration/man-camp-registration.js`
- Project docs: `README.md`, `docs/SETUP.md`, `docs/DATA-MODEL.md`, `docs/ADMIN-GUIDE.md`

The current system is structurally sound for reuse. The main mismatch is not the stack; it is the data model. The code assumes one registration equals one club, with roster and camping as club attributes. Man Camp needs one registration to represent a household/party or a single attendee submission, with lodging inventory tracked at bed/spot level.

## Current Architecture Summary

- WordPress Fluent Forms submits to `camporee_handle_submission()` in `ManCampRegistration/man-camp-registration.php`.
- The plugin normalizes fields into a JSON payload and posts `action: submitRegistration` to GAS.
- `Code.gs#doPost()` writes RAW audit data and calls `processRegistration()` in `Registration.gs`.
- `processRegistration()` writes:
  - one `Registrations` row
  - many `Roster` rows
  - one `CampingGroups` row
  - one `Assignments` row
- Email and report rebuilds are queued through `BackgroundJobs.gs`.
- Admin operations, check-in, reports, and PDFs all read from the same club-centric sheet structure.

## Camporee-Specific Assumptions To Remove

### Event naming and messaging

Hardcoded Camporee branding exists in:

- `Code.gs`: `doGet()`, setup alerts, menu title `🏕️ Camporee System`
- `Config.gs`: email subject, event name, dates, location
- `Email.gs`: confirmation subject/body/title content
- `Reports.gs`: sheet titles and legends
- `CheckIn.gs`: user-facing check-in messages
- `generateRegistrationPDF.gs`: folder names, header copy, summary email subject/body
- `AdminSidebar.html`: header subtitle, labels like “Check-In Club”
- `ManCampRegistration/man-camp-registration.php`: plugin name, admin page, logs, option labels
- `ManCampRegistration/man-camp-registration.js`: header comments and “First-time camper at a Camporee”
- `README.md`, `docs/SETUP.md`, `docs/DATA-MODEL.md`, `docs/ADMIN-GUIDE.md`

### Club-based entity model

The current system treats the registration owner as a club director and all attendees as belonging to a club:

- `Registration.gs`
  - `processRegistration()` normalizes `clubName`, `campingDetails`
  - `writeRegistrationRow_()` stores `club_name`, `church_name`, club-level counts
  - `processCampingGroup_()` creates one camping row per club
  - `writeAssignmentsRow_()` creates one assignment row per club
- `Reports.gs`
  - `getRosterDataByClub()` groups everything by `club_name`
  - both reports are club rollups
- `Admin.gs`
  - `adminPanelSearch()` searches club/director
  - `adminPanelGetClubDetails()` returns `clubName`, `directorName`, `assignedCampsite`
  - assignment manager is designed around one assignment record per club
- `CheckIn.gs`
  - `processClubCheckIn()` checks in the entire club in one action
- `Email.gs`
  - email copy assumes “your club”, “Club / Pathfinder Club”, church invoicing
- `generateRegistrationPDF.gs`
  - PDF is a club registration packet
- WordPress plugin and JS
  - `club_name`, `director_name`, `partner_club`, Pathfinder/TLT roles, “at least 1 Pathfinder”

### Pathfinder/Camporee program logic

These fields and workflows are event-specific and should be removed rather than repurposed:

- Duty preferences: `duty_first`, `duty_second`, `flag_slots`, `bathroom_days`
- Activity/program fields: `special_activity`, `special_type`, `special_type_church`, `av_equipment`, `campfire_night`, `game_name`, `game_action`, `oregon_trail_adult`, `special_name1`, `special_name2`, `sabbath_skit`, `partner_club`, `ribbons`
- Spiritual milestone fields: `baptism_names`, `bible_names`
- Staff specialty flags: `is_medical_personnel`, `is_master_guide_investiture`
- Roles: `pathfinder`, `tlt`, `staff`, `child`
- Menu/report names: “Club Dashboard”, “Camping Coordinator Summary”

## Club-Based Logic That Must Become Person/Lodging-Based

### Registration ownership

Current:

- One top-level row per club registration.
- Counts in `Registrations` are by Pathfinder/TLT/Staff/Child.
- Contact fields are “director” and “club”.

Target:

- One top-level row per reservation party or household, anchored by the primary contact.
- Every person row must carry lodging intent and lodging eligibility.
- Adult/guardian vs child becomes operationally important; Pathfinder/TLT/Staff does not.

### Lodging allocation

Current:

- `CampingGroups` only stores tents/trailers/canopies/square footage.
- `Assignments` has a free-text `camping_location` field.
- No capacity accounting exists.

Target:

- Capacity must be modeled by lodging category:
  - `cabin_no_bath_bottom_bunk`: 90
  - `cabin_with_bath_bottom_bunk`: 33
  - `rv_site`: configurable
  - `tent`: unlimited
- Bottom bunks are the public inventory.
- Top bunks are not public inventory and only become assignable to children linked to a guardian who already has a cabin assignment.
- Waitlisting must trigger when bottom-bunk inventory for the requested cabin category is exhausted.
- A child with no linked guardian must never auto-consume a bunk.

### Check-in

Current:

- One click checks in an entire club and returns one campsite assignment.

Target:

- Check-in should operate at reservation party level, with visibility into:
  - assigned lodging category
  - assigned unit/room/bed
  - which attendees are confirmed vs waitlisted
  - guardian-child linkage issues still unresolved

### Reporting

Current:

- Reports are club summaries.

Target:

- Reports need lodging and inventory views:
  - occupancy by lodging category
  - waitlist by category
  - children needing guardian linkage
  - cabin manifests by cabin/unit
  - RV roster
  - tent roster

## Proposed Target Data Model

Keep the six-sheet pattern, but replace the club/camping schema with reservation/lodging schema. Do not try to shoehorn this into the existing `CampingGroups` shape.

### 1. `RAW`

Keep, but change headers to:

| Header | Purpose |
|---|---|
| `timestamp` | webhook receipt time |
| `entry_id` | Fluent Forms entry ID |
| `primary_contact_name` | top-level contact |
| `primary_contact_email` | top-level contact email |
| `requested_lodging_summary` | compact human-readable lodging request |
| `party_json` | normalized people array |
| `lodging_json` | raw lodging preference/allocation request |
| `processed` | TRUE/FALSE |
| `payload_json` | full payload for replay |

### 2. `Registrations`

One row per reservation party.

Recommended headers:

| Header | Purpose |
|---|---|
| `timestamp` | submit time |
| `registration_id` | reservation ID |
| `fluent_form_entry_id` | idempotency key |
| `primary_contact_name` | lead contact |
| `primary_contact_email` | lead contact email |
| `primary_contact_phone` | lead contact phone |
| `church_name` | optional, if still needed |
| `party_name` | derived display label, e.g. `Durant Household` |
| `adult_count` | adults/guardians |
| `child_count` | minors |
| `total_attendees` | total people |
| `requested_lodging_type` | `cabin_no_bath` / `cabin_with_bath` / `rv` / `tent` |
| `requested_rv_length` | optional |
| `requested_rv_utility_notes` | optional |
| `bottom_bunks_requested` | computed |
| `top_bunks_requested` | computed children eligible for top bunk |
| `bottom_bunks_assigned` | assigned count |
| `top_bunks_assigned` | assigned count |
| `lodging_status` | `confirmed` / `partially_confirmed` / `waitlisted` / `tent_confirmed` / `rv_confirmed` |
| `waitlist_category` | blank or lodging category |
| `guardian_link_issues` | integer count |
| `estimated_total` | preserve billing hook if needed |
| `payment_status` | optional future use |
| `check_in_status` | `Arrived` etc. |
| `check_in_timestamp` | check-in time |
| `party_json` | normalized people snapshot |
| `lodging_request_json` | normalized lodging request snapshot |
| `assignment_json` | normalized lodging assignment snapshot |

### 3. `Roster`

One row per person, now modeled for lodging logic.

Recommended headers:

| Header | Purpose |
|---|---|
| `registration_id` | FK |
| `person_id` | unique person ID |
| `full_name` | person name |
| `age` | age |
| `gender` | optional |
| `person_type` | `adult` / `child` |
| `is_guardian` | TRUE/FALSE |
| `guardian_person_id` | child linkage |
| `guardian_name_snapshot` | denormalized lookup |
| `needs_bottom_bunk` | TRUE for adults/guardians in cabins |
| `eligible_for_top_bunk` | TRUE only for linked children |
| `lodging_preference` | requested lodging at person level if needed |
| `lodging_status` | `confirmed_bottom_bunk` / `confirmed_top_bunk` / `rv_confirmed` / `tent_confirmed` / `waitlisted` / `no_bunk_assigned` |
| `lodging_category` | assigned category |
| `lodging_unit` | cabin / RV site / tent grouping |
| `bed_label` | e.g. `Cabin A - Bottom 2`, `Top 1` |
| `requires_guardian_review` | TRUE/FALSE |
| `dietary_restrictions` | preserve |
| `notes` | medical/accessibility/general |
| `registrant_email` | denormalized |
| `timestamp` | created time |

### 4. `LodgingInventory`

Replace `CampingGroups` with a real inventory sheet.

Recommended headers:

| Header | Purpose |
|---|---|
| `lodging_category` | `cabin_no_bath_bottom_bunk`, `cabin_with_bath_bottom_bunk`, `rv_site`, `tent` |
| `public_capacity` | bottom bunk count or RV site count |
| `reserved_count` | confirmed public inventory |
| `waitlist_count` | current waitlist |
| `is_unlimited` | TRUE for tent |
| `config_notes` | admin notes |
| `last_updated` | timestamp |

Initial rows:

- `cabin_no_bath_bottom_bunk` = `public_capacity 90`
- `cabin_with_bath_bottom_bunk` = `public_capacity 33`
- `rv_site` = configurable, blank/default until set
- `tent` = `is_unlimited TRUE`

### 5. `Assignments`

Keep the sheet, but repurpose it from club program assignment to lodging assignment workflow.

Recommended headers:

| Header | Purpose |
|---|---|
| `registration_id` | FK |
| `primary_contact_name` | reservation contact |
| `primary_contact_email` | contact email |
| `requested_lodging_type` | requested category |
| `lodging_status` | current status |
| `assigned_lodging_category` | final category |
| `assigned_unit` | cabin/site/unit |
| `assigned_beds_summary` | compact assignment text |
| `waitlist_category` | if waitlisted |
| `waitlist_priority` | timestamp/order |
| `guardian_review_status` | `ok` / `needs_review` / `resolved` |
| `admin_notes` | notes |
| `email_sent` | checkbox |

### 6. `EmailLog`

Keep, but rename `club_name` column to `registration_label` or `party_name`.

## Proposed Webhook Payload Shape

The current payload is camporee-specific and top-level fields are mostly club metadata. Replace it with a party + lodging payload.

```json
{
  "action": "submitRegistration",
  "fluentFormEntryId": "1234",
  "submittedAt": "2026-03-09T10:30:00-05:00",
  "eventKey": "man-camp-2026",
  "primaryContact": {
    "name": "Caleb Durant",
    "email": "caleb@example.com",
    "phone": "(555) 555-5555",
    "churchName": "Springfield SDA Church"
  },
  "lodgingRequest": {
    "type": "cabin_no_bath",
    "rvSiteCount": 0,
    "rvLengthFeet": null,
    "tentCount": 0,
    "inventoryPolicyVersion": "1",
    "notes": "Needs lower bunk due to mobility."
  },
  "people": [
    {
      "id": "PERS-001",
      "name": "Caleb Durant",
      "age": 38,
      "gender": "Male",
      "personType": "adult",
      "isGuardian": true,
      "guardianPersonId": null,
      "dietaryRestrictions": "",
      "notes": "",
      "lodgingIntent": "cabin"
    },
    {
      "id": "PERS-002",
      "name": "Eli Durant",
      "age": 10,
      "gender": "Male",
      "personType": "child",
      "isGuardian": false,
      "guardianPersonId": "PERS-001",
      "dietaryRestrictions": "",
      "notes": "",
      "lodgingIntent": "cabin"
    }
  ],
  "attendeeCount": 2
}
```

### Payload processing rules in GAS

- `requested_lodging_type` drives inventory accounting.
- Adults/guardians requesting cabins increment bottom-bunk demand.
- Linked children requesting cabins do not increment public bottom-bunk inventory.
- Unlinked children are stored, flagged, and default to `no_bunk_assigned` until staff resolves them.
- `rv` consumes RV site inventory, not bunk inventory.
- `tent` bypasses inventory limits.

## Recommended Migration Strategy

### Phase 1: Rebrand and neutralize camporee program logic

- Replace event branding in all user-facing strings.
- Remove Pathfinder/TLT/program-specific fields from WordPress form mapping, GAS normalization, emails, PDF, reports, and docs.
- Rename admin labels from club/director to registration/contact/party.

This phase is mostly mechanical but touches nearly every file.

### Phase 2: Introduce the new reservation schema

- Update `setupSheets()` in `Code.gs` to create the new headers.
- Replace `CampingGroups` creation with `LodgingInventory`.
- Update RAW headers and row writer.
- Update helper docs and setup docs together.

This phase is the schema break.

### Phase 3: Rewrite registration ingestion around people + lodging

- Replace `Registration.gs#processRegistration()` normalization logic:
  - stop building `campingDetails`
  - accept `primaryContact`, `people`, `lodgingRequest`
- Replace `calculateCost_()` logic if pricing is still required.
- Replace `writeRegistrationRow_()`, `writeRosterRows_()`, `processCampingGroup_()`, `writeAssignmentsRow_()`.
- Add inventory allocation helpers:
  - `loadLodgingInventory_()`
  - `reserveBottomBunks_()`
  - `reserveRvSites_()`
  - `markTentRegistration_()`
  - `assignChildTopBunkEligibility_()`
  - `applyWaitlistStatus_()`

### Phase 4: Rebuild admin, reports, and check-in around lodging

- Replace club-based search/detail views with reservation-party views.
- Replace Assignment Manager with Lodging Manager.
- Replace Camping Coordinator reports with inventory/manifests/waitlists.
- Replace “check in club” with “check in reservation”.

### Phase 5: Rebuild outbound artifacts

- Rewrite confirmation email to show:
  - party members
  - lodging request
  - assigned status / waitlist status
  - guardian-child caveats
- Rewrite PDF to be a reservation summary, not a camporee program packet.

## File-by-File Impact Summary

### `Code.gs`

Impact: high.

- `doGet()` system name and ping response must change.
- `setupSheets()` and all `setup*Sheet_()` functions must be rewritten for new headers.
- `dangerEraseRawSheet()` and `writeRawRow_()` must use new RAW schema.
- `resyncFromRawSheet()` fallback path currently reconstructs club + camping payloads; it must reconstruct `primaryContact`, `people`, and `lodgingRequest`.
- `testConfirmationEmail()` is entirely camporee-specific and should become a Man Camp lodging test.
- `onOpen()` menu labels should change; report and admin items should reflect lodging and reservations, not clubs/camping.

### `Config.gs`

Impact: high.

- Replace event metadata.
- Replace `roleLabels` and `participatingRoles`; current Pathfinder/TLT/Staff/Child model is obsolete.
- Add lodging inventory configuration, especially RV capacity.
- Add status labels/constants for waitlist and guardian review.

### `Utilities.gs`

Impact: medium.

- Dynamic column mapping helpers remain reusable.
- `formatGender_()` is reusable.
- Add helpers for reservation IDs, person IDs, inventory calculations, and guardian validation.

### `Registration.gs`

Impact: highest.

- This is the core rewrite.
- Remove club/camping normalization and camporee field casting.
- Replace role-count calculations with adult/child/guardian counts.
- Add inventory reservation logic and waitlist logic.
- Replace `processCampingGroup_()` with `writeInventoryImpact_()` or direct inventory updates.
- `writeAssignmentsRow_()` must create lodging assignment state, not program assignment state.

### `Email.gs`

Impact: high.

- Subject/body/header/footer all reference Camporee and club semantics.
- Replace attendee role counts with reservation/lodging summaries.
- Remove duty/activity/spiritual milestone blocks.
- Add explicit language for:
  - confirmed lodging category
  - waitlist category
  - child top-bunk eligibility
  - children lacking guardian linkage

### `Reports.gs`

Impact: highest.

- `getRosterDataByClub()` must be replaced; grouping by `club_name` is wrong for Man Camp.
- Remove `generateClubDashboardSheet()` and `generateCampingCoordinatorSheet()` as primary reports.
- Replace with likely outputs:
  - `generateReservationDashboardSheet()`
  - `generateLodgingInventorySheet()`
  - `generateCabinManifestSheet()`
  - `generateWaitlistSheet()`
- The fake test data at the bottom is also club/pathfinder-specific.

### `CheckIn.gs`

Impact: high.

- Rename `processClubCheckIn()` to reservation-oriented flow.
- Stop returning “assigned campsite”; return lodging assignment summary.
- Check-in should surface unresolved child/guardian issues and waitlist statuses.

### `BackgroundJobs.gs`

Impact: medium.

- Queue architecture is reusable.
- Job payload currently carries `clubName`; replace with `partyName` or `primaryContactName`.
- Email reconstruction logic must read new registration and roster fields.
- Report rebuild target functions will change.

### `Admin.gs`

Impact: highest.

- Search must pivot from club/director to contact/person/reservation.
- `adminPanelGetClubDetails()` should become reservation details with lodging data.
- Add/remove attendee functions must maintain:
  - adult/child counts
  - guardian linkage
  - bottom-bunk and waitlist recalculation
- Current assignment manager must become lodging assignment manager.
- Duplicate detection should not use same-day club-name logic.

### `generateRegistrationPDF.gs`

Impact: high.

- PDF layout is almost entirely camporee-specific.
- All field indexing must change with new `Registrations` schema.
- Replace club packet with reservation/lodging summary and assignment manifest.
- Rename output folder from `Camporee 2026 – Registration PDFs`.

### `AdminSidebar.html`

Impact: high.

- UI labels, status cards, and actions are all club-centric.
- Headcount cards should become adult/child/confirmed/waitlist or similar.
- Assignment panel should become lodging panel.
- Remove camporee-specific wording and icons where misleading.
- Check-in button wording and details rendering must change.

### `ManCampRegistration/man-camp-registration.php`

Impact: highest.

- Plugin name/settings/docs strings must change.
- `CAMPOREE_FIELD_MAP`, `CAMPOREE_ARRAY_FIELDS`, and value whitelists must be replaced.
- `camporee_build_payload()` must emit `primaryContact`, `lodgingRequest`, and `people`.
- `camporee_sanitise_roster()` must be replaced with person/guardian/lodging sanitization.
- The “at least 1 Pathfinder” guard must be removed.
- Admin help text currently documents the wrong Fluent Forms schema.

### `ManCampRegistration/man-camp-registration.js`

Impact: highest.

- This widget is currently the biggest frontend schema mismatch.
- Replace roles `pathfinder/tlt/staff/child` with person types `adult/child`.
- Add guardian fields and child-to-guardian linkage UI.
- Remove staff-only medical/MG options unless still needed as general notes.
- Remove “at least one Pathfinder” rule.
- Add lodging-related validation:
  - children without guardian linkage flagged
  - adults/guardians counted toward bottom-bunk demand

### `README.md`

Impact: high.

- Rewrite overview, data model, reports, admin descriptions, and webhook examples.

### `docs/SETUP.md`

Impact: medium.

- Update plugin naming, required Fluent Forms fields, and report descriptions.

### `docs/DATA-MODEL.md`

Impact: highest.

- Entire sheet schema section must be rewritten.

### `docs/ADMIN-GUIDE.md`

Impact: high.

- Rewrite for reservation/lodging workflows instead of club/program workflows.

## Proposed Admin Workflow

### Submission intake

1. Public form collects:
   - primary contact
   - party members
   - adult/child status
   - guardian linkage for children
   - lodging request category
2. GAS stores RAW payload.
3. GAS allocates inventory immediately:
   - cabin bottom bunks if available
   - RV site if available
   - tent always confirmed
   - overflow to waitlist where needed
4. Confirmation email states the result clearly.

### Staff lodging management

1. Open “Lodging Manager” in sidebar.
2. Filter by:
   - confirmed
   - partially confirmed
   - waitlisted
   - guardian review needed
3. Open one reservation.
4. Assign:
   - lodging category
   - cabin/unit/site
   - per-person bed labels
5. Resolve any child-without-guardian issues.
6. Send updated assignment email.

### Check-in workflow

1. Search by reservation ID, primary contact, or attendee name.
2. Open reservation.
3. Review:
   - lodging assignment
   - party members
   - unresolved guardian flags
   - waitlisted status
4. Mark arrival.

## Major Risks And Edge Cases

### 1. Child linkage is the central business-rule risk

- The requirement “children can be assigned to top bunks only if registered with a guardian” cannot be solved with current free-form role fields.
- The form and schema must explicitly capture `guardian_person_id`.
- If not captured at submission time, staff work will become manual and error-prone.

### 2. Public inventory vs actual cabin occupancy are different numbers

- Public inventory is bottom bunks only.
- Actual occupancy can include top bunks for linked children.
- Reports and admin screens must show both values separately or staff will overbook cabins.

### 3. Reservation updates can change inventory state

- Current admin add/remove attendee logic just changes counts.
- In Man Camp, adding/removing adults or children can change:
  - bottom-bunk demand
  - top-bunk eligibility
  - waitlist status
- Inventory recalculation must happen after every roster mutation.

### 4. RV capacity is currently unknown

- The system must not hardcode RV inventory until the count is provided.
- `Config.gs` plus `LodgingInventory` should allow admins to set it without code edits.

### 5. Existing report assumptions will produce wrong operations data

- Grouping by `club_name` breaks once multiple unrelated individuals submit without a club.
- Duplicate detection by same club/day is no longer valid.

### 6. Existing PDFs and emails could mislead attendees if reused

- They currently promise club/camping/program details, not lodging assignment state.
- Reusing them unchanged would create operational confusion.

### 7. Backward compatibility with existing camporee rows is limited

- Once the sheet schema changes, old camporee data will not map cleanly.
- If historical retention matters, keep the old spreadsheet or migrate into archive tabs rather than live tabs.

## Concrete Recommended Implementation Order

1. Rewrite the WordPress form contract first.
   - Without the right payload shape, backend work will be unstable.
2. Rewrite sheet setup and data model second.
   - Establish canonical headers before touching admin/report consumers.
3. Rewrite `Registration.gs` third.
   - Implement lodging allocation, waitlist, and guardian rules.
4. Rewrite admin and reports fourth.
   - They depend on the new schema.
5. Rewrite email/PDF/check-in fifth.
   - These become straightforward once assignment data is correct.
6. Update docs last, but in the same release.

## Bottom Line

The existing infrastructure is worth keeping:

- GAS webhook architecture
- RAW auditing and replay
- Google Sheets admin surface
- background jobs
- WordPress-to-GAS bridge pattern

The parts that should not be preserved as-is are the data model and almost all club/pathfinder semantics. The migration should be treated as a schema and workflow refactor on top of a reusable integration shell, not as a simple rename from Camporee to Man Camp.

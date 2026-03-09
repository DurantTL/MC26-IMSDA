# Man Camp Fluent Forms Field Contract

This document defines the expected WordPress + Fluent Forms field names for the Man Camp registration form.

The current plugin implementation is in [man-camp-registration.php](/Users/calebdurant/Downloads/MANCAMP-IMSDA/ManCampRegistration/man-camp-registration.php) and [man-camp-registration.js](/Users/calebdurant/Downloads/MANCAMP-IMSDA/ManCampRegistration/man-camp-registration.js).

## Overview

The plugin now submits a person-based payload to the Google Apps Script webhook.

Preferred hidden payload field:

- `people_json`

Compatibility hidden payload field:

- `roster_json`

The plugin mirrors the same attendee array into both fields when they exist.

## Recommended Public Fields

Use these Fluent Forms field `Name` values where possible.

| Field Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `first_name` | Text | Yes | Primary registrant first name |
| `last_name` | Text | Yes | Primary registrant last name |
| `email` | Email | Yes | Primary contact email for confirmations |
| `phone` | Phone/Text | Yes | Primary contact phone |
| `lodging_preference` | Select/Radio | Yes | Use one of the allowed values below |
| `notes` | Textarea | No | General registration notes |

## Preferred Hidden Fields

| Field Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `people_json` | Hidden | Yes | Preferred attendee JSON field written by the widget |
| `roster_json` | Hidden | Recommended | Legacy mirror of `people_json` for compatibility |
| `attendee_count` | Hidden | Recommended | Attendee count fallback written by the widget |

## Attendee Object Shape

Each attendee written into `people_json` should look like this:

```json
{
  "id": "PERS-001",
  "first_name": "James",
  "last_name": "Smith",
  "email": "james@example.com",
  "phone": "555-111-2222",
  "age_group": "adult",
  "is_guardian": true,
  "guardian_link_key": "smith-household",
  "guardian_registration_id": "",
  "guardian_name_reference": "",
  "lodging_preference": "cabin_no_bath",
  "notes": "Lower bunk requested if available"
}
```

## Allowed Values

### `age_group`

- `adult`
- `child`

### `lodging_preference`

- `cabin_no_bath`
- `cabin_bath`
- `rv`
- `tent`

The plugin also normalizes these legacy aliases:

- `cabin_without_bath` -> `cabin_no_bath`
- `cabin_with_bath` -> `cabin_bath`

## Container Expectations

The widget looks for one of these container IDs:

- Preferred: `man-camp-people-container`
- Compatibility fallback: `man-camp-registration-container`

The widget is plain JavaScript and does not depend on unsupported Fluent Forms APIs.

## Webhook Payload Notes

The plugin posts to GAS with:

- `action: submitRegistration`
- `fluentFormEntryId`
- `submittedAt`
- top-level contact fields
- `people`
- `roster` as a compatibility alias
- `attendeeCount`

## Migration Notes

Camporee-era club and role fields are no longer part of the active Man Camp payload:

- `club_name`
- `director_name`
- `church_name`
- `tents`
- `trailer`
- `camp_next_to`
- Pathfinder/TLT/staff role fields
- duty, activity, and campsite-coordination fields

## TODOs

- TODO: confirm the production Fluent Forms field names exactly match the names above.
- TODO: confirm the form contains a hidden `people_json` field.
- TODO: keep a hidden `roster_json` field during transition if any older admin/report tooling still expects it.
- TODO: confirm the page includes a widget container with ID `man-camp-people-container` or keep the legacy `man-camp-registration-container`.

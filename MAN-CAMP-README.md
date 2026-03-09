# Man Camp Registration System

## Purpose

This repository now powers a Man Camp registration workflow built on Google Apps Script, Google Sheets, WordPress, and Fluent Forms.

The system is designed for:

- person-based registration
- guardian-led household submissions
- lodging assignment and waitlisting
- staff review of edge cases
- attendee-level on-site check-in

## Architecture

Public intake:

- WordPress + Fluent Forms
- custom bridge plugin in [man-camp-registration.php](/Users/calebdurant/Downloads/MANCAMP-IMSDA/ManCampRegistration/man-camp-registration.php)
- attendee widget in [man-camp-registration.js](/Users/calebdurant/Downloads/MANCAMP-IMSDA/ManCampRegistration/man-camp-registration.js)

Backend:

- Google Apps Script webhook in [Code.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Code.gs)
- registration normalization/writes in [Registration.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Registration.gs)
- lodging engine in [Lodging.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Lodging.gs)
- admin/search/manual edits in [Admin.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Admin.gs)
- check-in flow in [CheckIn.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/CheckIn.gs)
- confirmation email flow in [Email.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Email.gs)
- reports in [Reports.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Reports.gs)
- registration summary PDFs in [generateRegistrationPDF.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/generateRegistrationPDF.gs)

Database:

- Google Sheets workbook using named tabs defined in [Config.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Config.gs)

## Sheets Used

- `RAW`: raw webhook bodies plus normalized payload snapshots
- `Registrations`: one row per submission
- `Roster`: one row per attendee
- `CampingGroups`: legacy-named compatibility sheet carrying lodging summary per registration
- `Assignments`: legacy-named compatibility sheet carrying admin/lodging summary data
- `LodgingInventory`: current public inventory summary by lodging category
- `LodgingAssignments`: one row per attendee lodging decision
- `EmailLog`: send history

## Lodging Rules

Configured in [Config.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Config.gs):

- cabin without connected bathroom: 90 bottom bunks
- cabin with connected bathroom: 33 bottom bunks
- RV spots: configurable, currently `0` by default
- tent: unlimited

Operational rules:

- only bottom bunks count toward standard cabin inventory
- adults and guardians consume bottom-bunk inventory
- linked children may receive `top_guardian_child`
- top bunks do not reduce public bottom-bunk capacity
- a child without a guardian link does not get an automatic cabin bunk
- over-capacity cabin or RV requests move to `waitlist` or `manual_review`

## Deployment Steps

1. Create a Google Sheet and bind an Apps Script project to it.
2. Copy the `.gs` files and [AdminSidebar.html](/Users/calebdurant/Downloads/MANCAMP-IMSDA/AdminSidebar.html) into the Apps Script project.
3. Configure `appsscript.json` and add `PDFSHIFT_API_KEY` if PDF export is needed.
4. Review placeholders in [Config.gs](/Users/calebdurant/Downloads/MANCAMP-IMSDA/Config.gs).
5. Deploy the Apps Script project as a Web App.
6. In WordPress, install/activate the plugin folder [ManCampRegistration](/Users/calebdurant/Downloads/MANCAMP-IMSDA/ManCampRegistration).
7. In WordPress admin, open `Settings -> Man Camp Registration` and set:
   - GAS Web App URL
   - Fluent Form ID
   - registration page slug
   - debug mode as needed
8. Build the Fluent Forms form using [docs/MAN-CAMP-FORM-FIELDS.md](/Users/calebdurant/Downloads/MANCAMP-IMSDA/docs/MAN-CAMP-FORM-FIELDS.md).
9. In Google Sheets, run `Man Camp System -> Setup & Maintenance -> Initialize Sheets (Safe)`.
10. Test one live registration end-to-end before production use.

For detailed setup, see [docs/SETUP.md](/Users/calebdurant/Downloads/MANCAMP-IMSDA/docs/SETUP.md).

## Known Limitations

- Some legacy sheet columns still use older compatibility names, especially `club_name` and `roster_json`.
- `CampingGroups` and `Assignments` still exist as compatibility tables rather than fully renamed Man Camp tables.
- Manual lodging overrides can still be replaced by later roster rebuilds.
- This workspace is not currently a git repository, so no final commit can be created from here.

## Operator Notes

- Use the admin sidebar as the primary operational interface.
- Use `Generate ALL Reports` after significant manual lodging edits if staff want refreshed reporting sheets immediately.
- Waitlisted or manual-review attendees should not be checked in until staff resolve lodging.
- PDF export now produces attendee registration summaries, not camporee club packets.

# Setup & Deployment Guide

This guide walks through deploying CCRS-IMSDA from scratch, including the Google Apps Script backend, WordPress plugin, and PDF generation service.

> Current repo phase: the active registration, lodging, admin, check-in, email, reporting, and PDF flows are now Man Camp-oriented. Some legacy compatibility columns and internal function names still remain during the migration.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Google account | Must own the target Google Sheet |
| Google Sheet | Create a blank spreadsheet; this becomes the database |
| WordPress site | Version 5.8+ with Fluent Forms Pro installed |
| PDFShift account | Free tier: 50 PDFs/month. Required only for PDF generation. |

---

## 1. Google Apps Script Setup

### 1.1 Create the Apps Script Project

1. Open your target Google Sheet
2. Click **Extensions → Apps Script**
3. Delete the default `Code.gs` content
4. Create one script file per `.gs` file in this repository. Paste each file's content into the corresponding Apps Script file:
   - `Code.gs`
   - `Config.gs`
   - `Utilities.gs`
   - `Registration.gs`
   - `Email.gs`
   - `Reports.gs`
   - `CheckIn.gs`
   - `BackgroundJobs.gs`
   - `Admin.gs`
   - `generateRegistrationPDF.gs`
5. Create one HTML file: `AdminSidebar.html` — paste the content from `AdminSidebar.html` in this repository

> **Tip:** The Apps Script project must be bound to the Google Sheet (created via Extensions → Apps Script) so it can access the spreadsheet by `SpreadsheetApp.getActiveSpreadsheet()`.

### 1.2 Configure `appsscript.json`

In the Apps Script editor, click **Project Settings → Show "appsscript.json" manifest file in editor**, then replace the content with:

```json
{
  "timeZone": "America/Chicago",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/gmail.send"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

### 1.3 Add Script Properties

In the Apps Script editor, go to **Project Settings → Script Properties** and add:

| Property | Value | Notes |
|---|---|---|
| `PDFSHIFT_API_KEY` | Your PDFShift API key | Required for PDF generation only |

### 1.4 Review `Config.gs` Before Deployment

Before deploying, open `Config.gs` and update the Man Camp placeholders.

Required operator TODOs:

- `CONFIG.system.organizationName`
- `CONFIG.event.tagline`
- `CONFIG.event.dates`
- `CONFIG.event.location`
- `CONFIG.event.contactName`
- `CONFIG.email.fromName`
- `CONFIG.email.fromEmail`
- `CONFIG.email.replyTo`
- `CONFIG.email.contactEmail`
- `CONFIG.email.contactPhone`

Lodging configuration now lives in `Config.gs` and is centralized under `CONFIG.lodging`:

- `cabinNoBathBottomBunks: 90`
- `cabinBathBottomBunks: 33`
- `rvSpots: 0`
- `tentUnlimited: true`

If RV inventory becomes known, update `CONFIG.lodging.capacities.rvSpots` before go-live.

See [docs/MAN-CAMP-CONFIG.md](/Users/calebdurant/Downloads/MANCAMP-IMSDA/docs/MAN-CAMP-CONFIG.md) for the full configuration summary.

### 1.5 Deploy as Web App

1. Click **Deploy → New Deployment**
2. Select type: **Web App**
3. Set **Execute as**: `User deploying the script`
4. Set **Access**: `Anyone` (anonymous — no Google login required for form submissions)
5. Click **Deploy** and authorize the requested permissions
6. **Copy the deployment URL** — you will need it in step 2

> **Important:** Every time you update the script, you must create a **new deployment version** (Deploy → Manage Deployments → Edit → New Version). The URL stays the same but the code updates.

### 1.6 Initialize the Sheets

Back in the Google Sheet:

1. Reload the page to see the **Man Camp System** menu in the menu bar
2. Click **Man Camp System → Setup & Maintenance → Setup Sheets**
3. Authorize any additional permission prompts
4. Sheets will be created or updated: `RAW`, `Registrations`, `Roster`, `CampingGroups`, `Assignments`, `LodgingInventory`, `LodgingAssignments`, `EmailLog`

---

## 2. WordPress Plugin Setup

### 2.1 Install the Plugin

1. Copy the `ManCampRegistration/` folder to your WordPress plugins directory:
   ```
   wp-content/plugins/ManCampRegistration/
   ```
   The folder must contain:
   - `man-camp-registration.php`
   - `man-camp-registration.js`

2. In the WordPress admin, go to **Plugins** and activate **Man Camp Registration**

### 2.2 Configure the Plugin

The plugin settings are managed from the WordPress admin submenu:

- **Settings → Man Camp Registration**

Configure:

- GAS Web App URL
- Fluent Form ID
- registration page slug
- debug mode

Replace the old camporee-era field map with the current Man Camp field contract documented in [docs/MAN-CAMP-FORM-FIELDS.md](/Users/calebdurant/Downloads/MANCAMP-IMSDA/docs/MAN-CAMP-FORM-FIELDS.md).

### 2.3 Fluent Forms Configuration

The plugin hooks into Fluent Forms on form submission. Use the current Man Camp field contract documented in [docs/MAN-CAMP-FORM-FIELDS.md](/Users/calebdurant/Downloads/MANCAMP-IMSDA/docs/MAN-CAMP-FORM-FIELDS.md).

At minimum, the form should include:

- `first_name`
- `last_name`
- `email`
- `phone`
- `lodging_preference`
- `notes`
- hidden `people_json`
- hidden `attendee_count`

Recommended transition compatibility fields:

- hidden `roster_json`

### 2.4 Roster Widget

The `man-camp-registration.js` file now provides a Man Camp attendee widget. To embed it:

1. Enqueue the script on the registration form page, or add it via Fluent Forms' **Custom JS** setting
2. Prefer a container element with `id="man-camp-people-container"` inside the form
3. For transition compatibility, the widget will also attach to `id="man-camp-registration-container"` if present
4. The widget writes serialized attendee JSON to hidden `people_json`, mirrors it to `roster_json` when present, and updates `attendee_count`

See [docs/MAN-CAMP-FORM-FIELDS.md](/Users/calebdurant/Downloads/MANCAMP-IMSDA/docs/MAN-CAMP-FORM-FIELDS.md) for the attendee object shape and allowed lodging values.

---

## 3. PDF Generation Setup

PDF generation uses the **PDFShift** API service.

### 3.1 Sandbox vs. Production

In `generateRegistrationPDF.gs`, locate this constant:

```javascript
const PDFSHIFT_SANDBOX = true; // Set to false for production PDFs (no watermark)
```

- `true` — PDFs are generated with a watermark and don't count against your monthly quota. Use for testing.
- `false` — Production PDFs. Free tier allows 50 PDFs/month.

### 3.2 Google Drive Folder

PDFs are saved to the folder configured in `CONFIG.pdf.folderName` in the Google Drive account of the user who deployed the script. The current default is **"Man Camp Registration PDFs"**. The folder is created automatically on first PDF generation.

### 3.3 Generating PDFs

From the Google Sheet menu:
- **Man Camp System → PDF Generation → Generate Selected Registration Summary** — single registration summary PDF
- **Man Camp System → PDF Generation → Generate ALL Registration Summaries** — batch generation for all current registrations

Batch generation checkpoints progress in PropertiesService. If the 6-minute timeout fires mid-batch, the next trigger run picks up where it left off. Use **View PDF Generation Status** to check progress and **Cancel PDF Generation** to abort.

The PDF is now an attendee/registration summary, not a camporee-style club packet. See [docs/MAN-CAMP-REPORTS.md](/Users/calebdurant/Downloads/MANCAMP-IMSDA/docs/MAN-CAMP-REPORTS.md).

---

## 4. Email Configuration

Emails are sent from the Gmail account of the user who deployed the script. The `fromEmail` and `replyTo` in `Config.gs` set the display address and reply-to header, but the actual sending account is the deploying Google account.

To change the sender display name, from address appearance, or reply-to:

```javascript
// Config.gs
email: {
  fromName:  'TODO: Set sender display name',
  fromEmail: 'TODO: Set sender email address',
  replyTo:   'TODO: Set reply-to email address',
  ...
}
```

To disable emails during testing:

```javascript
email: {
  enabled: false,
  ...
}
```

### Testing

Use **Man Camp System → Email Management → Send Test Email** to send a sample confirmation to yourself before going live.

The confirmation email now includes:

- registration ID and primary contact details
- attendee-by-attendee lodging preference
- attendee lodging status (`assigned`, `waitlist`, `pending`, `manual_review`)
- bunk type and assigned area when available
- guardian-linked child messaging when applicable
- operator TODO reminders for final contact wording if placeholders remain in `Config.gs`

Before production, verify these `Config.gs` values:

- `CONFIG.email.subject`
- `CONFIG.email.fromName`
- `CONFIG.email.replyTo`
- `CONFIG.email.contactEmail`
- `CONFIG.email.contactPhone`
- `CONFIG.event.contactName`

---

## 5. Updating the System

When making changes to `.gs` or `.html` files:

1. Update the file content in the Apps Script editor
2. **Deploy → Manage Deployments → Edit** the existing deployment
3. Select **New Version** from the version dropdown
4. Click **Deploy**

The webhook URL does not change between versions.

---

## 6. Permissions Summary

The Apps Script project requests these OAuth scopes:

| Scope | Purpose |
|---|---|
| `spreadsheets` | Read/write all registration, roster, lodging, reporting, and email-log sheets |
| `drive` | Create PDF files in Google Drive |
| `script.external_request` | Call the PDFShift API |
| `script.scriptapp` | Create time-driven triggers for background jobs |
| `gmail.send` | Send confirmation emails |

---

## 7. Troubleshooting

### Registrations not appearing in the sheet

1. Check **Man Camp System → Setup & Maintenance → View Execution Log** for errors
2. Verify the GAS Web App URL in **Settings → Man Camp Registration** matches the current deployment URL
3. Confirm the deployment access is set to **Anyone, anonymous**

### Emails not sending

1. Check the `EmailLog` sheet for error messages
2. Verify `email.enabled` is `true` in `Config.gs`
3. Check **Execution Log** in Apps Script for Gmail permission errors

### Background jobs not processing

1. Check **Apps Script → Triggers** — there should be a one-off time-driven trigger
2. If stuck, run `processBackgroundJobs()` manually from the Apps Script editor
3. To clear a stuck queue, open Apps Script editor and run `clearBackgroundJobQueue()` (if available) or delete the `bgJobs` property via **Project Settings → Script Properties**

### Duplicate submissions appearing

The system uses the Fluent Forms `entry_id` as an idempotency key. If duplicates appear:
- Run **Man Camp System → Admin Tools → Find Duplicate Registrations** from the menu
- Duplicates can be deleted via the Admin Sidebar

### Re-processing raw submissions

If a registration was received but not fully processed (e.g., a script error mid-write), use:

**Man Camp System → Setup & Maintenance → Resync from RAW Sheet**

This re-processes all RAW sheet rows that are not yet marked as `processed = TRUE`.

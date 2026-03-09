# CCRS-IMSDA — Man Camp Registration System

**Man Camp registration, lodging, reporting, and check-in system for the Iowa-Missouri SDA Conference**

> Current codebase state: active workflows are Man Camp-oriented; some legacy compatibility columns and internal identifiers remain during migration.

---

## Overview

CCRS-IMSDA is a web-based Man Camp registration and management platform. It connects a WordPress/Fluent Forms public registration form to a Google Sheets backend via Google Apps Script, handling registration intake, lodging assignment, admin review, reporting, PDF export, and on-site attendee check-in.

### What the system does

1. **Accepts registrations** submitted through a WordPress/Fluent Forms multi-step form
2. **Processes and stores** attendee data and lodging assignments across Google Sheets
3. **Calculates fees** based on attendee count, late registration, and meal sponsorship discounts
4. **Sends confirmation emails** with a full HTML summary of registration details
5. **Generates lodging-first reports** for inventory, waitlist, guardian/child pairing, and RV/tent counts
6. **Produces attendee registration summary PDFs** for archival and on-site use
7. **Supports on-site attendee check-in** with lodging status safeguards

---

## Repository Structure

```
CCRS-IMSDA/
│
├── appsscript.json               # GAS manifest (OAuth scopes, runtime, timezone)
│
├── Code.gs                       # Entry points (doPost webhook, doGet health check),
│                                 #   admin menu definitions, setup functions
├── Config.gs                     # All system constants (pricing, colors, sheet names,
│                                 #   event info, email settings)
├── Utilities.gs                  # Shared helpers: dynamic column mapping, ID
│                                 #   generation, HTML escaping, date formatting
├── Registration.gs               # Core registration processor: parses webhook payload,
│                                 #   calculates costs, writes all four data sheets
├── Email.gs                      # HTML email builders and senders (Email 1: confirmation)
├── Reports.gs                    # Generates lodging-first operational reports
├── CheckIn.gs                    # On-site attendee check-in with lodging safeguards
├── BackgroundJobs.gs             # Async job queue system using PropertiesService and
│                                 #   time-driven triggers to avoid the 6-min GAS timeout
├── Admin.gs                      # Admin sidebar backend: search, add/remove attendees,
│                                 #   delete registrations, resend emails, find duplicates
├── generateRegistrationPDF.gs    # Batch PDF generation via PDFShift API with
│                                 #   checkpointing for long-running jobs
│
├── AdminSidebar.html             # Interactive admin panel UI (opens inside Google Sheets)
│
├── ManCampRegistration/
│   ├── man-camp-registration.php  # WordPress plugin: bridges Fluent Forms to GAS webhook
│   └── man-camp-registration.js        # Interactive roster widget embedded in Fluent Forms
│
└── docs/
    ├── SETUP.md                  # Deployment and initial configuration guide
    ├── DATA-MODEL.md             # Sheet schemas and column reference
    └── ADMIN-GUIDE.md            # Admin panel and menu operations
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Backend logic | Google Apps Script (V8 runtime) |
| Database | Google Sheets |
| File storage | Google Drive |
| Email | Gmail API via GAS |
| Public form | WordPress + Fluent Forms (multi-step) |
| Form-to-GAS bridge | PHP WordPress plugin |
| Attendee widget | Vanilla JavaScript |
| PDF generation | PDFShift API (external service) |

---

## Key Features

### Registration Processing
- Receives JSON webhook from WordPress on Fluent Forms submission
- Deduplicates submissions using Fluent Forms entry ID as idempotency key
- Generates unique registration IDs in the format `REG-2026-{3-digit}{3-letter}` (e.g., `REG-2026-042XKP`) — collision-safe with `LockService`
- Writes to four sheets atomically: Registrations, Roster, CampingGroups, Assignments
- Saves full webhook payload JSON to RAW sheet's `payload_json` column for complete audit and re-processing

### Cost Calculation
| Component | Amount |
|---|---|
| Base rate | $9 per person |
| Late fee (after April 10, 2026) | +$5 per person |
| Meal sponsorship discount | −$5 per person fed (capped at total attendees) |

Current billing logic bills adults/guardians rather than children. The estimated total is floored at $0.

### Email Confirmations
- HTML confirmation email sent after successful registration
- Includes attendee details, lodging preference, lodging status, bunk type, assigned area, and guardian-child linkage
- All sends logged to the EmailLog sheet with timestamp and status

### Async Job Queue
Email sending and report generation are offloaded to a background job queue (stored in PropertiesService) and executed via one-off time-driven triggers. This prevents the 6-minute Apps Script execution timeout from blocking registration responses.

### Reports
Active report sheets:
- **Registration Dashboard**
- **Lodging Inventory Summary**
- **Assigned vs Waitlisted**
- **Guardian Child Pairing**
- **RV and Tent Counts**

### Admin Panel
A Google Sheets sidebar UI provides:
- Search registrations by person name, registration ID, email, or phone
- View registration lodging details, guardian-child relationships, and per-attendee status
- Add or remove individual attendees — headcounts, `roster_json`, and `estimated_total` all update automatically
- Resend confirmation email with current attendee and lodging details
- Delete a registration and all associated rows
- Find duplicate submissions
- Validate data integrity
- **Lodging Queue** — a queue of registrations needing manual lodging attention

### On-Site Check-In
- Check in individual attendees
- Blocks waitlist and manual-review attendees from being checked in as assigned
- Prevents duplicate attendee check-ins

### PDF Generation
- Generates a registration summary PDF using the PDFShift API
- Batch processing with checkpointing — survives the 6-minute GAS timeout across multiple trigger executions
- PDFs saved to "Man Camp Registration PDFs" in Google Drive

---

## Quick Start

See **[docs/SETUP.md](docs/SETUP.md)** for the full deployment walkthrough.

**At a glance:**
1. Deploy the Apps Script project as a Web App (Execute as: User deploying; Access: Anyone, anonymous)
2. Enter the deployment URL in the WordPress plugin settings under **Settings -> Man Camp Registration**
3. Add your PDFShift API key to Script Properties as `PDFSHIFT_API_KEY`
4. Run **Man Camp System → Setup & Maintenance → Setup Sheets** from the Google Sheets menu to initialize the sheets

---

## Configuration

All configurable values live in **`Config.gs`**:

```javascript
const CONFIG = {
  sheets: {
    raw:           'RAW',
    registrations: 'Registrations',
    roster:        'Roster',
    campingGroups: 'CampingGroups',
    assignments:   'Assignments',
    lodgingInventory: 'LodgingInventory',
    lodgingAssignments: 'LodgingAssignments',
    emailLog:      'EmailLog'
  },
  email: {
    enabled:       true,
    fromName:      'TODO: Set sender display name',
    fromEmail:     'TODO: Set sender email address',
    replyTo:       'TODO: Set reply-to email address',
    subject:       'Man Camp Registration Received',
    eventName:     '2026 Man Camp',
    eventDates:    'TODO: Set Man Camp dates',
    eventLocation: 'TODO: Set Man Camp location',
    contactEmail:  'TODO: Set contact email',
    contactPhone:  'TODO: Set contact phone'
  },
  pricing: {
    baseRate:          9,    // $ per person
    lateFee:           5,    // $ per person after early bird deadline
    mealDiscount:      5,    // $ off per person fed (meal sponsorship)
    earlyBirdDeadline: new Date('2026-04-10T23:59:59')
  }
};
```

To change pricing, email addresses, event dates, or sheet names, edit only `Config.gs` — no other files need to change.

---

## Webhook API

### `POST /` — Registration submission

Accepts a JSON body from the WordPress plugin. On success, returns:

```json
{
  "success": true,
  "registrationId": "REG-2026-042XKP",
  "emailQueued": true,
  "attendeeCount": 15
}
```

On duplicate submission:

```json
{
  "success": true,
  "duplicate": true,
  "registrationId": "REG-2026-042XKP"
}
```

### `GET /?action=ping` — Health check

```json
{
  "status": "ok",
  "system": "2026 Man Camp",
  "timestamp": "2026-02-26T12:00:00.000Z"
}
```

---

## Docs

- [Setup & Deployment](docs/SETUP.md)
- [Data Model & Sheet Schemas](docs/DATA-MODEL.md)
- [Admin Guide](docs/ADMIN-GUIDE.md)

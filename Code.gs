// ============================================================
// Man Camp Registration System
// Google Apps Script — Code.gs (Entry Points, Setup & Admin)
// Updated: 2026 — Placeholder metadata configured in Config.gs
//
// Module structure:
//   Config.gs                  — CONFIG object
//   Utilities.gs               — column mapping, ID gen, string helpers
//   Registration.gs            — processRegistration, cost calc, sheet writers
//   Email.gs                   — sendConfirmationEmail_, HTML builder
//   Reports.gs                 — lodging-first operational reports
//   generateRegistrationPDF.gs — attendee registration summary PDFs via PDFShift
// ============================================================


// ============================================================
// SECTION 1 — ENTRY POINTS
// ============================================================

/**
 * HTTP POST handler — receives registration submissions from WordPress.
 */
function doPost(e) {
  try {
    const raw  = e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(raw);

    Logger.log('doPost received action: ' + data.action);

    if (data.action === 'submitRegistration') {
      // Write full payload to RAW sheet immediately for audit trail + resync capability.
      // This is non-fatal — a write failure must not block the registration.
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        writeRawRow_(ss, data, raw);
      } catch (rawErr) {
        Logger.log('doPost: RAW sheet write failed (non-fatal): ' + rawErr);
      }

      const result = processRegistration(data);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'Unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * HTTP GET handler — health check only.
 */
function doGet(e) {
  const action = e && e.parameter && e.parameter.action ? e.parameter.action : '';

  if (action === 'ping') {
    return ContentService
      .createTextOutput(JSON.stringify({
        status:    'ok',
        system:    CONFIG.system.healthCheckName,
        timestamp: new Date().toISOString()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', system: CONFIG.system.healthCheckName }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// SECTION 2 — EMAIL 2: ASSIGNMENT CONFIRMATIONS (stub)
// ============================================================

function sendAssignmentConfirmations() {
  SpreadsheetApp.getUi().alert(
    '⚠️ Email 2 function not yet deployed.\n\n' +
    'Add sendAssignmentConfirmations.gs to this project and redeploy.'
  );
}

function resendAssignmentByRegistrationId() {
  SpreadsheetApp.getUi().alert(
    '⚠️ Email 2 function not yet deployed.\n\n' +
    'Add sendAssignmentConfirmations.gs to this project and redeploy.'
  );
}

function bulkResendFailedAssignmentEmails() {
  SpreadsheetApp.getUi().alert(
    '⚠️ Email 2 bulk resend not yet deployed.\n\n' +
    'Add sendAssignmentConfirmations.gs to this project and redeploy.'
  );
}


// ============================================================
// SECTION 3 — PDF GENERATION STATUS
// ============================================================

/**
 * Shows the current status of an in-progress batch PDF generation.
 * Reads state saved to PropertiesService by generateAllClubPDFs().
 */
function viewPdfGenerationStatus() {
  const props    = PropertiesService.getScriptProperties();
  const stateJson = props.getProperty(PDF_STATE_KEY);
  if (!stateJson) {
    SpreadsheetApp.getUi().alert(
      'No PDF generation in progress.\n\nUse "Generate ALL Registration PDFs" to start.'
    );
    return;
  }
  let state;
  try { state = JSON.parse(stateJson); } catch (e) {
    SpreadsheetApp.getUi().alert('Could not read PDF generation state.');
    return;
  }
  const done  = state.successes.length + state.failures.length;
  const total = state.lastRow - 1;
  let msg = '⏳ PDF Generation In Progress\n\n'
    + 'Processed: ' + done + ' of ' + total + '\n'
    + 'Successes: ' + state.successes.length + '\n'
    + 'Failures:  ' + state.failures.length;
  if (state.failures.length > 0) {
    msg += '\n\nFailed:\n' + state.failures.join('\n');
  }
  msg += '\n\nBackground processing is continuing automatically.';
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Cancels an in-progress batch PDF generation and clears saved state.
 */
function cancelPdfGeneration() {
  const ui  = SpreadsheetApp.getUi();
  const btn = ui.alert(
    'Cancel PDF Generation?',
    'Stop the in-progress batch and clear saved state?',
    ui.ButtonSet.YES_NO
  );
  if (btn !== ui.Button.YES) return;
  deleteTriggersForFunction_('continuePdfGeneration_');
  PropertiesService.getScriptProperties().deleteProperty(PDF_STATE_KEY);
  ui.alert('✅ PDF generation cancelled.');
}


// ============================================================
// SECTION 4 — SETUP & MAINTENANCE
// ============================================================

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  setupRawSheet_(ss);
  setupRegistrationsSheet_(ss);
  setupRosterSheet_(ss);
  setupCampingGroupsSheet_(ss);
  setupAssignmentsSheet_(ss);
  setupLodgingInventorySheet_(ss);
  setupLodgingAssignmentsSheet_(ss);
  setupEmailLogSheet_(ss);

  SpreadsheetApp.getUi().alert(
    '✅ All sheets created and formatted.\n\n' +
    'Next step: deploy this script as a Web App and paste the URL into the WordPress plugin settings.\n\n' +
    'Sheets created/updated: RAW, Registrations, Roster, CampingGroups, Assignments, LodgingInventory, LodgingAssignments, EmailLog.'
  );
}

function setupRawSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.raw);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.raw);
  ensureSheetHeaders_(sheet, getRawHeaders_());
}

function setupRegistrationsSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.registrations);
  ensureSheetHeaders_(sheet, getRegistrationsHeaders_());
}

function setupRosterSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.roster);
  ensureSheetHeaders_(sheet, getRosterHeaders_());
}

function setupCampingGroupsSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.campingGroups);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.campingGroups);
  ensureSheetHeaders_(sheet, getCampingGroupsHeaders_());
}

function setupAssignmentsSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.assignments);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.assignments);
  const wasEmpty = sheet.getLastRow() === 0;
  ensureSheetHeaders_(sheet, getAssignmentsHeaders_());
  if (wasEmpty) {
    sheet.getRange(2, 10, 499, 1).insertCheckboxes();
  }
}

function setupEmailLogSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.emailLog);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.emailLog);
  ensureSheetHeaders_(sheet, getEmailLogHeaders_());
}

function setupLodgingInventorySheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.lodgingInventory);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.lodgingInventory);
  ensureSheetHeaders_(sheet, getLodgingInventoryHeaders_());
  seedLodgingInventorySheet_(sheet);
}

function setupLodgingAssignmentsSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.sheets.lodgingAssignments);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheets.lodgingAssignments);
  ensureSheetHeaders_(sheet, getLodgingAssignmentsHeaders_());
}

/**
 * Permanently erases all data in the RAW sheet and reapplies its headers.
 * Requires explicit YES confirmation before proceeding.
 */
function dangerEraseRawSheet() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    '⚠️ DANGER: ERASE DATA',
    'Are you sure you want to completely ERASE the RAW sheet?\n\nAll backup data will be permanently deleted. This cannot be undone.',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheets.raw);
  if (!sheet) {
    ui.alert('❌ RAW sheet not found. Run "Initialize Sheets (Safe)" first.');
    return;
  }

  sheet.clear();
  applyHeaders_(sheet, getRawHeaders_());

  ui.alert('✅ RAW sheet has been erased and headers have been reapplied.');
}

/**
 * Applies bold header row with conference color scheme, then freezes row 1.
 */
function applyHeaders_(sheet, headers) {
  const range = sheet.getRange(1, 1, 1, headers.length);
  range.setValues([headers]);
  range.setBackground(CONFIG.colors.headerBg);
  range.setFontColor(CONFIG.colors.headerFg);
  range.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

function ensureSheetHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    applyHeaders_(sheet, headers);
    return;
  }

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const existingSet = new Set(existing.filter(Boolean).map(h => h.toLowerCase()));
  const missing = headers.filter(h => !existingSet.has(String(h).toLowerCase()));

  if (missing.length === 0) return;

  const startCol = lastCol + 1;
  const range = sheet.getRange(1, startCol, 1, missing.length);
  range.setValues([missing]);
  range.setBackground(CONFIG.colors.headerBg);
  range.setFontColor(CONFIG.colors.headerFg);
  range.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(startCol, missing.length);
}

function getRawHeaders_() {
  return [
    'timestamp','entry_id','club_name','director_name','email',
    'phone','roster_json','camping_json','processed','payload_json',
    'primary_contact_name','primary_contact_email','party_json','lodging_json'
  ];
}

function getRegistrationsHeaders_() {
  return [
    'timestamp','registration_id','registrant_name','registrant_email','registrant_phone',
    'club_name','church_name',
    'total_pathfinders','total_tlt','total_staff','total_children','total_attendees',
    'duty_first','duty_second','flag_slots','bathroom_days',
    'special_activity','special_type','special_type_church','av_equipment',
    'campfire_night','game_name','game_action','oregon_trail_adult',
    'special_name1','meal_count','meal_times','partner_club','ribbons',
    'baptism_names','bible_names','sabbath_skit','estimated_total','late_fee_applied',
    'roster_json','fluent_form_entry_id','special_name2',
    // Phase 2 person-based model fields
    'first_name','last_name','email','phone','age_group','is_guardian',
    'guardian_registration_id','guardian_link_key','lodging_preference','lodging_status',
    'bunk_type','assigned_lodging_area','notes','created_at','registration_json',
    // Phase 5 registration-level check-in rollup fields
    'check_in_status','check_in_timestamp'
  ];
}

function getRosterHeaders_() {
  return [
    'registration_id','attendee_id','attendee_name','age','gender',
    'role','participation_status','dietary_restrictions',
    'is_medical_personnel','is_master_guide_investiture','is_first_time',
    'counts_toward_billing','club_name','registrant_email','timestamp',
    // Phase 2 person-based model fields
    'first_name','last_name','email','phone','age_group','is_guardian',
    'guardian_registration_id','guardian_link_key','lodging_preference','lodging_status',
    'bunk_type','assigned_lodging_area','notes','created_at',
    // Phase 5 individual check-in fields
    'check_in_status','check_in_timestamp'
  ];
}

function getCampingGroupsHeaders_() {
  return [
    'registration_id','club_name',
    'tents','trailer','kitchen_canopy','total_sqft','camp_next_to',
    'pathfinder_count','tlt_count','staff_count','child_count',
    'total_headcount','timestamp',
    // Phase 2 person-based lodging summary fields
    'lodging_preference','lodging_status','bunk_type_summary','assigned_lodging_area',
    'notes','adult_count','guardian_count'
  ];
}

function getAssignmentsHeaders_() {
  return [
    'registration_id','club_name','director_email',
    'duty_assigned','duty_time_day',
    'special_activity_assigned','activity_detail',
    'camping_location','camping_notes',
    'email_2_sent',
    // Phase 2 person-based assignment placeholders
    'lodging_preference','lodging_status','bunk_type_summary','assigned_lodging_area',
    'guardian_link_key','notes','created_at'
  ];
}

function getEmailLogHeaders_() {
  return [
    'timestamp','registration_id','email','club_name','status','error_message'
  ];
}

function getLodgingInventoryHeaders_() {
  return [
    'lodging_category','label','inventory_type','public_capacity','assigned_public_units',
    'assigned_top_bunks','waitlist_count','manual_review_count','remaining_public_capacity',
    'is_unlimited','last_recalculated_at','notes'
  ];
}

function getLodgingAssignmentsHeaders_() {
  return [
    'registration_id','attendee_id','full_name','age_group','is_guardian','guardian_link_key',
    'guardian_registration_id','lodging_preference','lodging_status','bunk_type',
    'assigned_lodging_area','inventory_category','consumes_public_inventory',
    'assignment_reason','created_at','updated_at',
    // Phase 5 individual check-in fields
    'check_in_status','check_in_timestamp'
  ];
}


// ============================================================
// SECTION 5 — ADMIN TOOLS
// ============================================================

function validateDataIntegrity() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  const rstSheet = ss.getSheetByName(CONFIG.sheets.roster);

  if (!regSheet || !rstSheet) {
    SpreadsheetApp.getUi().alert('Cannot validate — one or more required sheets are missing. Run Setup Sheets first.');
    return;
  }

  const regIdCol    = getColumnNumber_(regSheet, 'registration_id');
  const rosterIdCol = getColumnNumber_(rstSheet, 'registration_id');

  const regIds    = (regSheet.getLastRow() > 1 && regIdCol > 0)
    ? regSheet.getRange(2, regIdCol, regSheet.getLastRow() - 1, 1).getValues().flat()
    : [];
  const rosterIds = (rstSheet.getLastRow() > 1 && rosterIdCol > 0)
    ? rstSheet.getRange(2, rosterIdCol, rstSheet.getLastRow() - 1, 1).getValues().flat()
    : [];

  const orphaned  = rosterIds.filter(id => id && !regIds.includes(id));
  const rosterSet = new Set(rosterIds);
  const missing   = regIds.filter(id => id && !rosterSet.has(id));

  const msg = [
    '✅ Data Integrity Check',
    '──────────────────────',
    `Registrations: ${regIds.filter(Boolean).length}`,
    `Roster rows:   ${rosterIds.filter(Boolean).length}`,
    '',
    orphaned.length > 0
      ? `⚠ ${orphaned.length} orphaned roster row(s) with no matching registration:\n${orphaned.join(', ')}`
      : '✅ No orphaned roster rows.',
    missing.length > 0
      ? `⚠ ${missing.length} registration(s) with no roster rows:\n${missing.join(', ')}`
      : '✅ All registrations have roster rows.'
  ].join('\n');

  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Resends Email 1 (confirmation) for the selected row in the Registrations sheet.
 *
 * Uses readRowAsObject_() from Utilities.gs to read column values by header
 * name — no hardcoded array indices. This is resilient to column reordering.
 */
function adminResendConfirmationEmail() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  if (sheet.getName() !== CONFIG.sheets.registrations) {
    SpreadsheetApp.getUi().alert('Please select a row in the Registrations sheet first.');
    return;
  }

  const row = sheet.getActiveRange().getRow();
  if (row < 2) { SpreadsheetApp.getUi().alert('Please select a data row (not the header).'); return; }

  // Dynamic column read — no hardcoded indices
  const r      = readRowAsObject_(sheet, row);
  const regId  = r['registration_id'];
  const email  = r['registrant_email'];

  if (!email) { SpreadsheetApp.getUi().alert('No email address found for this row.'); return; }

  try {
    const data = buildConfirmationEmailDataFromRegistration_(ss, regId);
    sendConfirmationEmail_(data);
    logEmail_(ss, regId, data.registrantEmail, data.registrationLabel, 'email1_resent', '');
    SpreadsheetApp.getUi().alert('✅ Confirmation email (Email 1) resent to ' + data.registrantEmail);
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Email failed: ' + err.toString());
  }
}

/**
 * Prompts for a name fragment and searches the Roster sheet for matches.
 * Uses dynamic column mapping to avoid hardcoded indices.
 */
function adminSearchAttendee() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.prompt('Search Attendee', 'Enter name (partial matches work):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const query = resp.getResponseText().trim().toLowerCase();
  if (!query) return;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!sheet || sheet.getLastRow() < 2) {
    ui.alert('Roster sheet is empty.');
    return;
  }

  // Dynamic column mapping
  const colMap = getColumnMap_(sheet);
  const data   = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  const matches = data.filter(row => {
    const name = row[colMap['attendee_name']];
    return name && name.toString().toLowerCase().includes(query);
  });

  if (matches.length === 0) {
    ui.alert('No attendees found matching "' + query + '".');
    return;
  }

  const lines = matches.map(r =>
    `• ${r[colMap['attendee_name']]} | ${r[colMap['role']]} | Age ${r[colMap['age']]} | ${r[colMap['club_name']]} | Reg: ${r[colMap['registration_id']]}`
  );
  ui.alert(`Found ${matches.length} result(s):\n\n` + lines.join('\n'));
}

/**
 * Scans the Registrations sheet for duplicate Fluent Forms entry IDs
 * and for the same club submitting more than once on the same day.
 * Uses dynamic column mapping to avoid hardcoded indices.
 */
function adminFindDuplicates() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!sheet || sheet.getLastRow() < 3) {
    SpreadsheetApp.getUi().alert('Not enough registrations to check for duplicates.');
    return;
  }

  // Dynamic column mapping
  const allRows = sheet.getDataRange().getValues();
  const colMap  = {};
  allRows[0].forEach((h, i) => { colMap[String(h).trim().toLowerCase()] = i; });

  const dataRows = allRows.slice(1);
  const entryIds = {};
  const clubs    = {};
  const dupes    = [];

  dataRows.forEach((row, i) => {
    const entryId = String(row[colMap['fluent_form_entry_id']] || '');
    const club    = String(row[colMap['club_name']] || '').toLowerCase();
    const tsRaw   = row[colMap['timestamp']];
    const date    = tsRaw ? Utilities.formatDate(new Date(tsRaw), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '';

    if (entryId && entryId !== 'undefined' && entryId !== '') {
      if (entryIds[entryId]) {
        dupes.push(`Duplicate entry_id ${entryId}: rows ${entryIds[entryId] + 1} and ${i + 2}`);
      } else {
        entryIds[entryId] = i + 1;
      }
    }

    const key = club + '|' + date;
    if (clubs[key]) {
      dupes.push(`Same club on same day: "${row[colMap['club_name']]}" rows ${clubs[key] + 1} and ${i + 2}`);
    } else {
      clubs[key] = i + 1;
    }
  });

  SpreadsheetApp.getUi().alert(
    dupes.length === 0
      ? '✅ No duplicates found.'
      : `⚠ ${dupes.length} potential duplicate(s):\n\n` + dupes.join('\n')
  );
}

function adminDeleteRegistration() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.prompt('Delete Registration', 'Enter the Registration ID to delete:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const regId = resp.getResponseText().trim();
  if (!regId) return;

  const confirm = ui.alert(
    'Confirm Delete',
    `Are you sure you want to delete registration ${regId}?\n\n` +
    'This will remove the registration row, all roster rows, lodging summary rows, and assignment rows. This cannot be undone.',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  let   deleted = 0;

  [
    CONFIG.sheets.registrations,
    CONFIG.sheets.roster,
    CONFIG.sheets.campingGroups,
    CONFIG.sheets.assignments
  ].forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;

    // Dynamic column lookup — no hardcoded index
    const colIndex = getColumnNumber_(sheet, 'registration_id');
    if (colIndex < 0) return;
    const data     = sheet.getRange(2, colIndex, sheet.getLastRow() - 1, 1).getValues().flat();

    for (let i = data.length - 1; i >= 0; i--) {
      if (String(data[i]) === regId) {
        sheet.deleteRow(i + 2);
        deleted++;
      }
    }
  });

  ui.alert(`✅ Deleted ${deleted} row(s) associated with ${regId}.`);
}

function adminAddPersonToGroup() {
  const ui = SpreadsheetApp.getUi();

  const regResp = ui.prompt('Add Person', 'Registration ID (e.g. REG-2026-001):', ui.ButtonSet.OK_CANCEL);
  if (regResp.getSelectedButton() !== ui.Button.OK) return;
  const regId = regResp.getResponseText().trim();

  const nameResp = ui.prompt('Add Person', 'Full Name:', ui.ButtonSet.OK_CANCEL);
  if (nameResp.getSelectedButton() !== ui.Button.OK) return;
  const name = nameResp.getResponseText().trim();

  const roleResp = ui.prompt('Add Person', 'Role (pathfinder / tlt / staff / child):', ui.ButtonSet.OK_CANCEL);
  if (roleResp.getSelectedButton() !== ui.Button.OK) return;
  const role = roleResp.getResponseText().trim().toLowerCase();

  const ageResp = ui.prompt('Add Person', 'Age:', ui.ButtonSet.OK_CANCEL);
  if (ageResp.getSelectedButton() !== ui.Button.OK) return;
  const age = parseInt(ageResp.getResponseText().trim(), 10);

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheets.roster);

  sheet.appendRow([
    regId,
    'MANUAL-' + Date.now(),
    name,
    age || '',
    '',
    role,
    'returning',
    '',
    'No',
    'No',
    'No',
    'Yes',
    '',
    '',
    new Date()
  ]);

  ui.alert(`✅ ${name} added to roster under ${regId}.`);
}

function adminRemovePersonFromRoster() {
  const ui = SpreadsheetApp.getUi();

  const nameResp = ui.prompt('Remove Person', 'Full Name (must match exactly):', ui.ButtonSet.OK_CANCEL);
  if (nameResp.getSelectedButton() !== ui.Button.OK) return;
  const name = nameResp.getResponseText().trim();

  const regResp = ui.prompt('Remove Person', 'Registration ID:', ui.ButtonSet.OK_CANCEL);
  if (regResp.getSelectedButton() !== ui.Button.OK) return;
  const regId = regResp.getResponseText().trim();

  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!rosterSheet || rosterSheet.getLastRow() < 2) { ui.alert('Roster sheet is empty.'); return; }

  // Dynamic column mapping
  const colMap   = getColumnMap_(rosterSheet);
  const allRows  = rosterSheet.getRange(2, 1, rosterSheet.getLastRow() - 1, rosterSheet.getLastColumn()).getValues();
  let   removed  = 0;
  let   removedRole = '';

  for (let i = allRows.length - 1; i >= 0; i--) {
    const rowRegId   = String(allRows[i][colMap['registration_id']] || '');
    const rowName    = String(allRows[i][colMap['attendee_name']]   || '');
    if (rowRegId === regId && rowName.toLowerCase() === name.toLowerCase()) {
      removedRole = String(allRows[i][colMap['role']] || '').toLowerCase();
      rosterSheet.deleteRow(i + 2);
      removed++;
    }
  }

  if (removed === 0) {
    ui.alert(`No matching rows found for "${name}" in registration ${regId}.`);
    return;
  }

  // Decrement headcounts in Registrations sheet
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (regSheet && regSheet.getLastRow() > 1 && removedRole) {
    const regData = regSheet.getDataRange().getValues();
    const regCol  = {};
    regData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { regCol[h] = i; });
    for (let r = 1; r < regData.length; r++) {
      if (String(regData[r][regCol['registrationid']] || '') !== regId) continue;
      const rowNum = r + 1;
      const roleCountCols = { pathfinder: 'totalpathfinders', tlt: 'totaltlt', staff: 'totalstaff', child: 'totalchildren' };
      const roleCol = roleCountCols[removedRole];
      if (roleCol && regCol[roleCol] !== undefined) {
        const cur = parseInt(regData[r][regCol[roleCol]], 10) || 0;
        regSheet.getRange(rowNum, regCol[roleCol] + 1).setValue(Math.max(0, cur - removed));
      }
      if (regCol['totalattendees'] !== undefined) {
        const cur = parseInt(regData[r][regCol['totalattendees']], 10) || 0;
        regSheet.getRange(rowNum, regCol['totalattendees'] + 1).setValue(Math.max(0, cur - removed));
      }
      // Update roster_json snapshot
      const rosterJsonCol = getColumnNumber_(regSheet, 'roster_json');
      if (rosterJsonCol > 0) {
        try {
          const stored = JSON.parse(String(regData[r][regCol['rosterjson']] || '[]'));
          const filtered = stored.filter(p => (p.name || '').toLowerCase() !== name.toLowerCase());
          regSheet.getRange(rowNum, rosterJsonCol).setValue(JSON.stringify(filtered));
        } catch (e) { /* non-fatal */ }
      }
      break;
    }
  }

  ui.alert(`✅ Removed ${removed} row(s) for "${name}" from registration ${regId}. Headcounts updated.`);
}

/**
 * Re-processes a selected row from the RAW sheet.
 * Useful if a registration failed silently on first attempt.
 */
function resyncFromRawSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  if (sheet.getName() !== CONFIG.sheets.raw) {
    SpreadsheetApp.getUi().alert('Please select a row in the RAW sheet first.');
    return;
  }

  const row = sheet.getActiveRange().getRow();
  if (row < 2) { SpreadsheetApp.getUi().alert('Please select a data row (not the header).'); return; }

  // Use dynamic column mapping so RAW column order changes don't break resync
  const r         = readRowAsObject_(sheet, row);
  const entryId   = String(r['entry_id'] || '');
  const processed = String(r['processed'] || '').toUpperCase();

  if (processed === 'TRUE') {
    const ui      = SpreadsheetApp.getUi();
    const confirm = ui.alert(
      'Already Processed',
      `Entry ${entryId} is already marked as processed. Re-process anyway? This may create duplicate data.`,
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;
  }

  let data;

  // Prefer full payload_json (stored since v1.5+). Fall back to basic fields with a warning.
  const payloadJson = r['payload_json'] || '';
  if (payloadJson) {
    try {
      data = JSON.parse(payloadJson);
      // Always override the entry ID from the RAW row so the duplicate guard uses the right key.
      data.fluentFormEntryId = entryId;
    } catch (e) {
      Logger.log('resyncFromRawSheet: could not parse payload_json — falling back to basic fields: ' + e);
    }
  }

  if (!data) {
    // Fallback path: RAW row was written before payload_json was added.
    // Legacy rows may only have the denormalized roster/camping JSON snapshots.
    const confirm2 = SpreadsheetApp.getUi().alert(
      '⚠ Limited Data Available',
      'This RAW entry pre-dates the full payload store.\n\n' +
      'Resyncing will rebuild the registration from the stored participant and lodging snapshots.\n\n' +
      'Proceed with basic data only?',
      SpreadsheetApp.getUi().ButtonSet.YES_NO
    );
    if (confirm2 !== SpreadsheetApp.getUi().Button.YES) return;

    const party   = JSON.parse(r['party_json']   || r['roster_json']  || '[]');
    const lodging = JSON.parse(r['lodging_json'] || r['camping_json'] || '{}');
    data = {
      fluentFormEntryId: entryId,
      first_name:        String(r['primary_contact_name'] || r['director_name'] || '').split(' ')[0] || '',
      last_name:         String(r['primary_contact_name'] || r['director_name'] || '').split(' ').slice(1).join(' '),
      email:             r['primary_contact_email'] || r['email'],
      phone:             r['phone'],
      clubName:          r['club_name'],
      registrantName:    r['director_name'],
      registrantEmail:   r['email'],
      registrantPhone:   r['phone'],
      people:            party,
      roster:            party,
      lodging_preference: lodging.lodging_preference || lodging.type || '',
      lodgingRequest:    lodging,
      campingDetails:    lodging
    };
  }

  try {
    const result = processRegistration(data);
    SpreadsheetApp.getUi().alert('✅ Resynced successfully.\nRegistration ID: ' + result.registrationId);
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Resync failed: ' + err.toString());
  }
}


/**
 * Appends a row to the RAW sheet with the full webhook payload for audit
 * and resync purposes. Called at the top of doPost() before processRegistration().
 *
 * The `payload_json` column stores the complete raw request body so that
 * resyncFromRawSheet() can reconstruct the full registration if ever needed.
 *
 * @param {Spreadsheet} ss        — active spreadsheet
 * @param {Object}      data      — parsed payload object
 * @param {string}      rawJson   — original raw JSON string from the request
 */
function writeRawRow_(ss, data, rawJson) {
  const sheet = ss.getSheetByName(CONFIG.sheets.raw);
  if (!sheet) {
    Logger.log('writeRawRow_: RAW sheet not found — skipping.');
    return;
  }
  sheet.appendRow([
    new Date(),
    String(data.fluentFormEntryId || data.entry_id || ''),
    data.clubName            || data.club_name    || '',
    data.registrantName      || data.director_name || '',
    data.registrantEmail     || data.email         || '',
    data.registrantPhone     || data.phone         || '',
    JSON.stringify(data.roster         || []),
    JSON.stringify(data.campingDetails || {}),
    'FALSE',
    rawJson || '',  // full payload for resync
    data.primaryContact && data.primaryContact.name
      ? data.primaryContact.name
      : (data.registrantName || data.director_name || ''),
    data.primaryContact && data.primaryContact.email
      ? data.primaryContact.email
      : (data.registrantEmail || data.email || ''),
    JSON.stringify(data.people || data.roster || []),
    JSON.stringify(data.lodgingRequest || { lodging_preference: data.lodging_preference || '' })
  ]);
}

/**
 * Sends a test Email 1 to the current user with all fields exercised.
 * Use this to verify the email template renders correctly.
 */
function testConfirmationEmail() {
  const testData = {
    registrationId:      'REG-TEST-001',
    registrantName:      'James Smith',
    registrantEmail:     Session.getEffectiveUser().getEmail(),
    registrantPhone:     '(515) 555-0100',
    registrationLabel:   'Smith Household',
    timestamp:           new Date(),
    lodgingPreference:   'cabin_no_bath',
    lodgingStatus:       'manual_review',
    assignedLodgingArea: 'Cabin Area TBD',
    notes:               'TODO: Replace this sample note before showing stakeholders.',
    roster: [
      { id: 'GUARD-001', name: 'James Smith', age: 41, ageGroup: 'adult', isGuardian: true, lodgingPreference: 'cabin_no_bath', lodgingStatus: 'assigned', bunkType: 'bottom', assignedLodgingArea: 'Cabin A-3' },
      { id: 'ADULT-002', name: 'Michael Reed', age: 38, ageGroup: 'adult', isGuardian: false, lodgingPreference: 'rv', lodgingStatus: 'waitlist', bunkType: 'none', assignmentReason: 'RV spots are currently full.' },
      { id: 'CHILD-001', name: 'Ethan Smith', age: 12, ageGroup: 'child', isGuardian: false, guardianLinkKey: 'smith-family', lodgingPreference: 'cabin_no_bath', lodgingStatus: 'assigned', bunkType: 'top_guardian_child', assignedLodgingArea: 'Cabin A-3' },
      { id: 'CHILD-002', name: 'Noah Smith', age: 9, ageGroup: 'child', isGuardian: false, lodgingPreference: 'cabin_no_bath', lodgingStatus: 'manual_review', bunkType: 'none', assignmentReason: 'Child is missing a guardian link and cannot be auto-assigned a cabin bunk.' }
    ],
    costBreakdown: {
      estimatedTotal: 54
    }
  };

  try {
    sendConfirmationEmail_(testData);
    SpreadsheetApp.getUi().alert(
      '✅ Test email sent to ' + Session.getEffectiveUser().getEmail() + '.\n\nCheck your inbox.'
    );
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Test email failed: ' + err.toString());
  }
}

function viewEmailLog() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheets.emailLog);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Email log sheet not found. Run Setup Sheets first.');
    return;
  }
  ss.setActiveSheet(sheet);
  SpreadsheetApp.getUi().alert(`Email log has ${Math.max(0, sheet.getLastRow() - 1)} entries.\n\nYou are now viewing the EmailLog sheet.`);
}


// ============================================================
// SECTION 6 — MENU
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(CONFIG.system.menuTitle)
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('⚙️ Setup & Maintenance')
        .addItem('🔧 Initialize Sheets (Safe)',     'setupSheets')
        .addItem('✅ Validate Data Integrity',      'validateDataIntegrity')
        .addItem('🔄 Resync Selected RAW Entry',    'resyncFromRawSheet')
        .addSeparator()
        .addItem('⚠️ ERASE Raw Sheet',              'dangerEraseRawSheet')
    )
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('📊 Generate Reports')
        .addItem('🧾 Registration Dashboard',      'generateClubDashboardSheet')
        .addItem('🏕️ Lodging Inventory Summary',   'generateCampingCoordinatorSheet')
        .addItem('📊 Generate ALL Reports',         'generateAllReportSheets')
    )
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('📧 Email Management')
        .addItem('📤 Send Assignment Confirmations (Email 2)',       'sendAssignmentConfirmations')
        .addItem('📤 Resend Confirmation Email 1 (Selected Row)',    'adminResendConfirmationEmail')
        .addItem('📋 Resend Assignment by Registration ID',          'resendAssignmentByRegistrationId')
        .addItem('📊 Bulk: Resend Failed Assignment Emails',         'bulkResendFailedAssignmentEmails')
        .addItem('📝 View Email Log',                                'viewEmailLog')
        .addItem('📧 Send Test Email (Email 1)',                     'testConfirmationEmail')
        .addSeparator()
        .addItem('⚡ Process Background Jobs Now',                   'processBackgroundJobs')
    )
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('📄 PDF Generation')
        .addItem('📄 Generate Selected Registration Summary', 'generatePDFForSelectedClub')
        .addItem('📂 Generate ALL Registration Summaries',    'generateAllClubPDFs')
        .addSeparator()
        .addItem('📊 View PDF Generation Status',     'viewPdfGenerationStatus')
        .addItem('⛔ Cancel PDF Generation',           'cancelPdfGeneration')
    )
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('👤 Admin Tools')
        .addItem('🖥️ Open Admin Panel (Sidebar)',  'showAdminSidebar')
        .addSeparator()
        .addItem('➕ Add Person to Roster',      'adminAddPersonToGroup')
        .addItem('➖ Remove Person from Roster',  'adminRemovePersonFromRoster')
        .addItem('🔍 Search Attendee',            'adminSearchAttendee')
        .addItem('👥 Find Duplicates',             'adminFindDuplicates')
        .addItem('🗑️ Delete Registration',        'adminDeleteRegistration')
    )
    .addToUi();
}

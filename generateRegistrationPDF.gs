// ============================================================
// generateRegistrationPDF.gs
// Man Camp attendee registration summary PDFs via PDFShift.
// ============================================================

const PDFSHIFT_SANDBOX = true;
const PDF_STATE_KEY = 'PDF_GEN_STATE';

function getPdfShiftApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('PDFSHIFT_API_KEY');
  if (!key) {
    throw new Error(
      'PDFSHIFT_API_KEY not found in Script Properties.\n\n' +
      'Open the Apps Script editor -> Project Settings -> Script Properties,\n' +
      'then add PDFSHIFT_API_KEY from https://pdfshift.io/dashboard'
    );
  }
  return key;
}


// ============================================================
// SECTION 1 — PUBLIC ENTRY POINTS
// ============================================================

function generatePDFForSelectedClub() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  if (sheet.getName() !== CONFIG.sheets.registrations) {
    SpreadsheetApp.getUi().alert('Please select a row in the Registrations sheet first.\nCurrent sheet: ' + sheet.getName());
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row <= 1) {
    SpreadsheetApp.getUi().alert('Please select a data row, not the header row.');
    return;
  }

  try {
    const result = generatePdfForRow_(ss, sheet, row);
    SpreadsheetApp.getUi().alert(
      'PDF generated.\n\nSaved to "' + CONFIG.pdf.folderName + '".\n\nFile: ' + result.filename +
      (PDFSHIFT_SANDBOX ? '\n\nSandbox mode is ON, so the PDF will include a watermark.' : '')
    );
  } catch (err) {
    SpreadsheetApp.getUi().alert('Error generating PDF:\n\n' + err.message);
  }
}

function generateAllClubPDFs() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const existingJson = props.getProperty(PDF_STATE_KEY);

  if (existingJson) {
    let existing = null;
    try { existing = JSON.parse(existingJson); } catch (err) {}
    if (existing) {
      const done = (existing.successes || []).length + (existing.failures || []).length;
      const total = existing.lastRow - 1;
      const choice = ui.alert(
        'PDF Generation In Progress',
        done + ' of ' + total + ' PDF(s) processed so far.\n\nCancel the current batch and start over?',
        ui.ButtonSet.YES_NO
      );
      if (choice !== ui.Button.YES) return;
      deleteTriggersForFunction_('continuePdfGeneration_');
      props.deleteProperty(PDF_STATE_KEY);
    }
  }

  const response = ui.alert(
    'Generate registration PDFs?',
    'Creates one attendee summary PDF per registration in "' + CONFIG.pdf.folderName + '".' +
      (PDFSHIFT_SANDBOX ? '\n\nSandbox mode is ON, so PDFs will include a watermark.' : ''),
    ui.ButtonSet.OK_CANCEL
  );
  if (response !== ui.Button.OK) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!regSheet) {
    ui.alert('Registrations sheet not found.');
    return;
  }

  const lastRow = regSheet.getLastRow();
  if (lastRow < 2) {
    ui.alert('No registrations found.');
    return;
  }

  const state = { nextRow: 2, lastRow, successes: [], failures: [] };
  const result = runPdfBatch_(ss, regSheet, state);

  if (result.done) {
    let message = 'Generated ' + result.state.successes.length + ' PDF(s).';
    if (result.state.failures.length) {
      message += '\n\nFailures:\n' + result.state.failures.join('\n');
    }
    ui.alert(message);
    return;
  }

  props.setProperty(PDF_STATE_KEY, JSON.stringify(result.state));
  deleteTriggersForFunction_('continuePdfGeneration_');
  ScriptApp.newTrigger('continuePdfGeneration_').timeBased().after(30 * 1000).create();
  ui.alert('PDF generation is continuing in the background.');
}

function continuePdfGeneration_() {
  deleteTriggersForFunction_('continuePdfGeneration_');

  const props = PropertiesService.getScriptProperties();
  let state = null;
  try {
    state = JSON.parse(props.getProperty(PDF_STATE_KEY) || 'null');
  } catch (err) {}

  if (!state) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!regSheet) {
    props.deleteProperty(PDF_STATE_KEY);
    return;
  }

  state.lastRow = Math.max(state.lastRow, regSheet.getLastRow());
  const result = runPdfBatch_(ss, regSheet, state);

  if (result.done) {
    props.deleteProperty(PDF_STATE_KEY);
    sendPdfBatchSummaryEmail_(result.state);
    return;
  }

  props.setProperty(PDF_STATE_KEY, JSON.stringify(result.state));
  ScriptApp.newTrigger('continuePdfGeneration_').timeBased().after(30 * 1000).create();
}


// ============================================================
// SECTION 2 — BATCH PROCESSING
// ============================================================

function runPdfBatch_(ss, regSheet, state) {
  const startMs = Date.now();
  const limitMs = 5 * 60 * 1000;

  while (state.nextRow <= state.lastRow) {
    if (Date.now() - startMs >= limitMs) {
      return { done: false, state };
    }

    const row = state.nextRow;
    state.nextRow++;

    try {
      const result = generatePdfForRow_(ss, regSheet, row);
      state.successes.push(result.filename);
    } catch (err) {
      const label = String(readRowAsObject_(regSheet, row).registration_id || 'Row ' + row);
      state.failures.push(label + ': ' + err.message);
      Logger.log('runPdfBatch_: row ' + row + ' failed: ' + err.message);
    }
  }

  return { done: true, state };
}

function sendPdfBatchSummaryEmail_(state) {
  const total = state.successes.length + state.failures.length;
  const subject = CONFIG.pdf.batchCompleteSubject + ' — ' + state.successes.length + '/' + total + ' succeeded';
  const body = [
    'PDF generation complete.',
    '',
    'Successes: ' + state.successes.length,
    'Failures: ' + state.failures.length,
    state.failures.length ? '\nFailed PDFs:\n' + state.failures.join('\n') : '',
    '',
    'Files are saved in "' + CONFIG.pdf.folderName + '" on Google Drive.'
  ].join('\n');

  try {
    GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
  } catch (err) {
    Logger.log('sendPdfBatchSummaryEmail_: ' + err);
  }
}


// ============================================================
// SECTION 3 — CORE GENERATOR
// ============================================================

function generatePdfForRow_(ss, regSheet, row) {
  const reg = readRowAsObject_(regSheet, row);
  const registrationId = String(reg.registration_id || '').trim();
  if (!registrationId) {
    throw new Error('No registration ID found on row ' + row + '.');
  }

  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  const people = rosterSheet ? readPeopleForRegistrationFromRoster_(rosterSheet, registrationId) : [];
  const html = buildPdfHtml_({
    registration: reg,
    people
  });

  const registrationLabel = String(reg.registration_label || reg.club_name || reg.registrant_name || registrationId).trim();
  const safeName = registrationLabel.replace(/[^\w\s\-]/g, '').trim() || registrationId;
  const filename = registrationId + ' - ' + safeName + '.pdf';
  const blob = htmlToPdfBlob_(html, filename);
  const file = getPdfFolder_().createFile(blob);
  return { filename: file.getName(), fileId: file.getId() };
}


// ============================================================
// SECTION 4 — HTML BUILDER
// ============================================================

function buildPdfHtml_(context) {
  const reg = context.registration;
  const people = context.people || [];
  const registrationId = String(reg.registration_id || '').trim();
  const registrationLabel = String(reg.registration_label || reg.club_name || reg.registrant_name || registrationId).trim();
  const registrantName = String(reg.registrant_name || [reg.first_name, reg.last_name].filter(Boolean).join(' ').trim() || registrationLabel).trim();
  const registrantEmail = String(reg.registrant_email || reg.email || '').trim();
  const registrantPhone = String(reg.registrant_phone || reg.phone || '').trim();
  const lodgingPreference = String(reg.lodging_preference || '').trim();
  const lodgingStatus = String(reg.lodging_status || '').trim();
  const assignedLodgingArea = String(reg.assigned_lodging_area || '').trim();
  const notes = String(reg.notes || '').trim();
  const flags = collectPdfFlags_(people);
  const guardianPairs = buildGuardianChildPdfPairs_(people);
  const counts = summarizePdfPeopleCounts_(people);
  const submittedAt = reg.timestamp ? new Date(reg.timestamp).toLocaleString('en-US') : '';

  const attendeeRows = people.map((person) => {
    const fullName = escapeHtml_(String(person.name || [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || '').trim());
    const guardianRelationship = buildGuardianRelationshipLabel_(person, people);
    return `
      <tr>
        <td>${fullName || '&mdash;'}</td>
        <td>${escapeHtml_(String(person.ageGroup || '').trim()) || '&mdash;'}</td>
        <td>${person.isGuardian ? 'Yes' : 'No'}</td>
        <td>${escapeHtml_(String(person.lodgingPreference || '').trim()) || '&mdash;'}</td>
        <td>${escapeHtml_(String(person.lodgingStatus || '').trim()) || '&mdash;'}</td>
        <td>${escapeHtml_(String(person.bunkType || '').trim()) || '&mdash;'}</td>
        <td>${escapeHtml_(String(person.assignedLodgingArea || '').trim()) || '&mdash;'}</td>
        <td>${escapeHtml_(guardianRelationship) || '&mdash;'}</td>
      </tr>
    `;
  }).join('');

  const guardianPairRows = guardianPairs.length
    ? guardianPairs.map((pair) => `
      <tr>
        <td>${escapeHtml_(pair.childName)}</td>
        <td>${escapeHtml_(pair.guardianName || 'Unlinked')}</td>
        <td>${escapeHtml_(pair.bunkType || '') || '&mdash;'}</td>
        <td>${escapeHtml_(pair.lodgingStatus || '') || '&mdash;'}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="4">No child attendees on this registration.</td></tr>';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: Helvetica, Arial, sans-serif; margin: 24px; color: #1f2937; }
    h1, h2, h3, p { margin: 0; }
    .header { border-bottom: 3px solid #1d4f5f; padding-bottom: 14px; margin-bottom: 20px; }
    .eyebrow { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #6b7280; }
    .title { font-size: 28px; color: #123845; margin-top: 6px; }
    .subtitle { color: #4b5563; margin-top: 4px; }
    .section { margin-top: 20px; }
    .section h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .8px; color: #123845; margin-bottom: 10px; }
    .grid { width: 100%; border-collapse: collapse; }
    .grid td { padding: 8px 10px; border: 1px solid #d7dee4; vertical-align: top; }
    .grid td.label { width: 28%; background: #f5f8fa; font-weight: 700; color: #425466; }
    table.roster { width: 100%; border-collapse: collapse; font-size: 11px; }
    table.roster th, table.roster td { border: 1px solid #d7dee4; padding: 7px 8px; text-align: left; }
    table.roster th { background: #e9f0f4; color: #123845; }
    .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
    .stat { padding: 8px 10px; background: #f5f8fa; border: 1px solid #d7dee4; border-radius: 8px; font-size: 12px; }
    .flags { padding: 10px 12px; background: #fff7ed; border-left: 4px solid #c2410c; border-radius: 6px; }
    .muted { color: #6b7280; }
    .notes { white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="header">
    <div class="eyebrow">${escapeHtml_(CONFIG.system.organizationName)}</div>
    <div class="title">${escapeHtml_(CONFIG.event.name)} Registration Summary</div>
    <div class="subtitle">${escapeHtml_(CONFIG.event.dates)}${CONFIG.event.location ? ' · ' + escapeHtml_(CONFIG.event.location) : ''}</div>
  </div>

  <div class="section">
    <h2>Registration</h2>
    <table class="grid">
      <tr><td class="label">Registration ID</td><td>${escapeHtml_(registrationId)}</td></tr>
      <tr><td class="label">Registration Label</td><td>${escapeHtml_(registrationLabel)}</td></tr>
      <tr><td class="label">Primary Contact</td><td>${escapeHtml_(registrantName) || '&mdash;'}</td></tr>
      <tr><td class="label">Email</td><td>${escapeHtml_(registrantEmail) || '&mdash;'}</td></tr>
      <tr><td class="label">Phone</td><td>${escapeHtml_(registrantPhone) || '&mdash;'}</td></tr>
      <tr><td class="label">Submitted</td><td>${escapeHtml_(submittedAt) || '&mdash;'}</td></tr>
      <tr><td class="label">Lodging Preference</td><td>${escapeHtml_(lodgingPreference) || '&mdash;'}</td></tr>
      <tr><td class="label">Lodging Status</td><td>${escapeHtml_(lodgingStatus) || '&mdash;'}</td></tr>
      <tr><td class="label">Assigned Area</td><td>${escapeHtml_(assignedLodgingArea) || '&mdash;'}</td></tr>
      <tr><td class="label">Notes</td><td class="notes">${escapeHtml_(notes) || '&mdash;'}</td></tr>
    </table>
    <div class="stats">
      <div class="stat">Attendees: <strong>${people.length}</strong></div>
      <div class="stat">Adults: <strong>${counts.adult}</strong></div>
      <div class="stat">Children: <strong>${counts.child}</strong></div>
      <div class="stat">Guardians: <strong>${counts.guardian}</strong></div>
    </div>
  </div>

  <div class="section">
    <h2>Attendees</h2>
    <table class="roster">
      <thead>
        <tr>
          <th>Name</th>
          <th>Age Group</th>
          <th>Guardian</th>
          <th>Lodging Preference</th>
          <th>Status</th>
          <th>Bunk Type</th>
          <th>Assigned Area</th>
          <th>Guardian Link</th>
        </tr>
      </thead>
      <tbody>
        ${attendeeRows || '<tr><td colspan="8">No attendee rows found.</td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="section">
    <h2>Guardian and Child Pairings</h2>
    <table class="roster">
      <thead>
        <tr>
          <th>Child</th>
          <th>Guardian</th>
          <th>Bunk Type</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${guardianPairRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Staff Flags</h2>
    <div class="flags">
      ${flags.length ? '<ul><li>' + flags.map(escapeHtml_).join('</li><li>') + '</li></ul>' : '<span class="muted">No special review flags on this registration.</span>'}
    </div>
  </div>
</body>
</html>`;
}

function collectPdfFlags_(people) {
  const flags = [];
  people.forEach((person) => {
    const ageGroup = String(person.ageGroup || '').toLowerCase();
    const hasGuardianLink = String(person.guardianLinkKey || person.guardianRegistrationId || '').trim() !== '';
    const lodgingStatus = String(person.lodgingStatus || '').toLowerCase();
    const lodgingPreference = String(person.lodgingPreference || '').toLowerCase();

    if (ageGroup === 'child' && !hasGuardianLink) flags.push('Child attendee without guardian link');
    if (lodgingStatus === 'waitlist' && lodgingPreference.indexOf('cabin') === 0) flags.push('Cabin request is waitlisted');
    if (lodgingStatus === 'manual_review') flags.push('One or more attendees require manual lodging review');
  });

  return flags.filter((flag, index, arr) => arr.indexOf(flag) === index);
}

function summarizePdfPeopleCounts_(people) {
  return people.reduce((acc, person) => {
    if (String(person.ageGroup || '').toLowerCase() === 'child') acc.child++;
    else acc.adult++;
    if (person.isGuardian) acc.guardian++;
    return acc;
  }, { adult: 0, child: 0, guardian: 0 });
}

function buildGuardianChildPdfPairs_(people) {
  const guardiansByLink = {};
  const guardiansById = {};

  people.forEach((person) => {
    if (!person.isGuardian) return;
    if (person.guardianLinkKey) guardiansByLink[person.guardianLinkKey] = person.name;
    if (person.id) guardiansById[person.id] = person.name;
  });

  return people
    .filter((person) => String(person.ageGroup || '').toLowerCase() === 'child')
    .map((person) => ({
      childName: person.name,
      guardianName: guardiansByLink[person.guardianLinkKey] || guardiansById[person.guardianRegistrationId] || '',
      bunkType: person.bunkType,
      lodgingStatus: person.lodgingStatus
    }));
}

function buildGuardianRelationshipLabel_(person, allPeople) {
  if (!person || String(person.ageGroup || '').toLowerCase() !== 'child') {
    return person && person.isGuardian ? 'Guardian' : '';
  }

  const guardian = allPeople.find((candidate) => {
    if (!candidate.isGuardian) return false;
    if (person.guardianLinkKey && candidate.guardianLinkKey) {
      return person.guardianLinkKey === candidate.guardianLinkKey;
    }
    return person.guardianRegistrationId && candidate.id === person.guardianRegistrationId;
  });

  return guardian ? guardian.name : (person.guardianLinkKey || person.guardianRegistrationId || '');
}


// ============================================================
// SECTION 5 — PDF UTILITY HELPERS
// ============================================================

function htmlToPdfBlob_(html, filename) {
  const apiKey = getPdfShiftApiKey_();
  const payload = {
    source: html,
    sandbox: PDFSHIFT_SANDBOX,
    format: 'Letter'
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode('api:' + apiKey)
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://api.pdfshift.io/v3/convert/pdf', options);
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('PDFShift API error (HTTP ' + code + '): ' + response.getContentText().substring(0, 300));
  }

  return response.getBlob().setName(filename);
}

function getPdfFolder_() {
  const folderName = CONFIG.pdf.folderName;
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(folderName);
}

// ============================================================
// Man Camp Registration System
// Google Apps Script — Admin.gs
//
// Backend functions for the HTML Admin Panel sidebar.
// All public functions are callable via google.script.run from
// AdminSidebar.html.  They return plain objects (no UI calls).
//
// Functions:
//   showAdminSidebar()                        — opens the sidebar
//   adminPanelSearch(query)                   — search registrations & attendees
//   adminPanelGetClubDetails(registrationId)  — lodging-first registration detail
//   adminPanelResendEmail(registrationId)     — resend confirmation (Email 1)
//   adminPanelDeleteRegistration(regId)       — purge all rows for a reg
//   adminPanelAddAttendee(regId, attendee)    — add person to roster
//   adminPanelRemoveAttendee(regId, attendId) — remove person from roster
//   adminPanelGeneratePDF(registrationId)     — generate PDF via PDFShift
//   adminGenerateClubDashboards()             — generate registration dashboard
//   adminGenerateCampingCoordinatorSummary()  — generate lodging inventory summary
//   adminValidateDataIntegrity()              — check data integrity
//   adminFindDuplicates()                     — find duplicate registrations
//   adminPanelUpdateEstimatedTotal(regId, newTotal) — override total cost
//   adminPanelRevokeMealDiscount(regId)       — set meal count to 0 and recalc
// ============================================================


// ============================================================
// SECTION 1 — SIDEBAR LAUNCHER
// ============================================================

/**
 * Opens the Admin Panel sidebar in the Spreadsheet UI.
 * Wired to the 🏠 Admin Panel menu item added in onOpen().
 */
function showAdminSidebar() {
  const template = HtmlService.createTemplateFromFile('AdminSidebar');
  template.panelTitle = CONFIG.system.adminPanelTitle;
  template.panelSubtitle = CONFIG.system.adminPanelSub;

  const html = template.evaluate()
    .setTitle(CONFIG.system.adminPanelTitle)
    .setWidth(420);
  SpreadsheetApp.getUi().showSidebar(html);
}


// ============================================================
// SECTION 2 — SEARCH
// ============================================================

/**
 * Searches registrations and roster rows for a query string.
 * Matches registration ID, registration label, person names,
 * email addresses, and phone numbers.
 *
 * @param  {string}   query — search term (≥2 characters)
 * @returns {Object[]}      up to 20 result objects:
 *   { type, registrationId, attendeeId?, label, sublabel, lodgingStatus?, needsAttention? }
 */
function adminPanelSearch(query) {
  if (!query || query.trim().length < 2) return [];

  const q = query.trim().toLowerCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = [];
  const seen = new Set();

  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (regSheet && regSheet.getLastRow() > 1) {
    const data    = regSheet.getDataRange().getValues();
    const headers = data[0];
    const col     = {};
    headers.map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { col[h] = i; });

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const regId = String(row[col['registrationid']] || '');
      if (!regId) continue;

      const firstName = String(row[col['firstname']] || '');
      const lastName = String(row[col['lastname']] || '');
      const email = String(row[col['email']] || row[col['registrantemail']] || '');
      const phone = String(row[col['phone']] || row[col['registrantphone']] || '');
      const label = String(row[col['registrationlabel']] || row[col['clubname']] || [firstName, lastName].join(' ').trim() || row[col['registrantname']] || 'Registration');
      const primaryName = [firstName, lastName].join(' ').trim() || String(row[col['registrantname']] || '');
      const lodgingStatus = String(row[col['lodgingstatus']] || '').toLowerCase();
      const lodgingPreference = String(row[col['lodgingpreference']] || '').toLowerCase();

      const haystack = [
        regId,
        label,
        primaryName,
        email,
        phone,
        lodgingStatus,
        lodgingPreference
      ].join(' ').toLowerCase();

      if (haystack.includes(q) && !seen.has(regId)) {
        seen.add(regId);
        out.push({
          type: 'registration',
          registrationId: regId,
          label: label,
          sublabel: [regId, primaryName || email || phone, formatAdminLodgingSummary_(lodgingPreference, lodgingStatus)].filter(Boolean).join(' · '),
          lodgingStatus: lodgingStatus || 'pending',
          needsAttention: lodgingStatus === 'waitlist' || lodgingStatus === 'manual_review'
        });
      }
    }
  }

  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (rosterSheet && rosterSheet.getLastRow() > 1) {
    const data    = rosterSheet.getDataRange().getValues();
    const headers = data[0];
    const col     = {};
    headers.map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { col[h] = i; });

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const regId = String(row[col['registrationid']] || '');
      const attendeeId = String(row[col['attendeeid']] || '');
      const firstName = String(row[col['firstname']] || '');
      const lastName = String(row[col['lastname']] || '');
      const fullName = String(row[col['attendeename']] || [firstName, lastName].join(' ').trim());
      const email = String(row[col['email']] || row[col['registrantemail']] || '');
      const phone = String(row[col['phone']] || '');
      const lodgingStatus = String(row[col['lodgingstatus']] || '').toLowerCase();
      const haystack = [fullName, regId, attendeeId, email, phone].join(' ').toLowerCase();

      if (haystack.includes(q)) {
        const key = regId + '::' + attendeeId;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            type: 'attendee',
            registrationId: regId,
            attendeeId: attendeeId,
            label: fullName,
            sublabel: [attendeeId, regId, email || phone, lodgingStatus || 'pending'].filter(Boolean).join(' · '),
            lodgingStatus: lodgingStatus || 'pending',
            needsAttention: lodgingStatus === 'waitlist' || lodgingStatus === 'manual_review'
          });
        }
      }
    }
  }

  const MAX_RESULTS = 20;
  return {
    results:    out.slice(0, MAX_RESULTS),
    truncated:  out.length > MAX_RESULTS,
    totalFound: out.length
  };
}


// ============================================================
// SECTION 3 — CLUB DETAILS
// ============================================================

/**
 * Returns a lodging-first details object for one registration.
 *
 * Reads from Registrations, Roster, LodgingAssignments, and LodgingInventory.
 * Uses dynamic column mapping throughout so column order changes are tolerated.
 *
 * @param  {string} registrationId
 * @returns {Object}  details object (or { error: string } on failure)
 */
function adminPanelGetClubDetails(registrationId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!regSheet) return { error: 'Registrations sheet not found.' };
  const regRowIndex = findRegistrationRow_(regSheet, registrationId);
  if (regRowIndex < 0) return { error: 'No registration found for ID: ' + registrationId };
  const reg = readRowAsObject_(regSheet, regRowIndex);

  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  const people = rosterSheet ? readPeopleForRegistrationFromRoster_(rosterSheet, registrationId) : [];
  const roster = people.map(person => buildAdminRosterPerson_(person));
  const flags = buildAttentionFlagsForRegistration_(reg, people);
  const inventory = adminPanelGetInventorySummary();

  const ts = reg['timestamp'];
  const checkInTs = reg['check_in_timestamp'];
  const checkInTsStr = checkInTs
    ? (() => {
        try {
          return new Date(checkInTs).toLocaleString('en-US', {
            timeZone: 'America/Chicago',
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true
          });
        } catch (e) { return ''; }
      })()
    : '';

  const primaryName = [reg['first_name'] || '', reg['last_name'] || ''].join(' ').trim() || reg['registrant_name'] || '';
  const registrationLabel = reg['registration_label'] || reg['club_name'] || deriveRegistrationLabel_({ lastName: reg['last_name'] || '', fullName: primaryName }, reg);
  const lodgingPreference = normalizeLodgingPreference_(reg['lodging_preference'] || '');
  const lodgingStatus = String(reg['lodging_status'] || deriveRegistrationLodgingStatus_(people)).toLowerCase();
  const assignedLodgingArea = String(reg['assigned_lodging_area'] || reg['camping_location'] || '').trim();

  return {
    registrationId: registrationId,
    registrationLabel: registrationLabel,
    clubName: registrationLabel,
    churchName: String(reg['church_name'] || ''),
    primaryContactName: primaryName,
    primaryContactEmail: String(reg['email'] || reg['registrant_email'] || ''),
    primaryContactPhone: String(reg['phone'] || reg['registrant_phone'] || ''),
    directorName: primaryName,
    directorEmail: String(reg['email'] || reg['registrant_email'] || ''),
    directorPhone: String(reg['phone'] || reg['registrant_phone'] || ''),
    timestamp:        ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    headcount: {
      adults: people.filter(person => person.ageGroup === 'adult').length,
      children: people.filter(person => person.ageGroup === 'child').length,
      guardians: people.filter(person => person.isGuardian).length,
      waitlisted: people.filter(person => person.lodgingStatus === 'waitlist').length,
      total: people.length
    },
    estimatedTotal: parseFloat(reg['estimated_total']) || 0,
    optionPrice: parseFloat(reg['option_price']) || 0,
    amountPaid: parseFloat(reg['amount_paid']) || 0,
    paymentStatus: String(reg['payment_status'] || ''),
    paymentReference: String(reg['payment_reference'] || ''),
    firstTimers: roster.filter(a => a.isFirstTime).length,
    lodgingPreference: lodgingPreference,
    lodgingStatus: lodgingStatus,
    bunkTypeSummary: reg['bunk_type'] || deriveBunkTypeSummary_(people),
    assignedLodgingArea: assignedLodgingArea,
    assignedCampsite: assignedLodgingArea,
    notes: String(reg['notes'] || ''),
    roster: roster,
    attentionFlags: flags,
    needsAttention: flags.length > 0,
    inventorySummary: inventory.inventory,
    inventoryAttention: inventory.attention,
    checkInStatus: String(reg['check_in_status'])  || '',
    checkInTimestamp: checkInTsStr,
    checkInSummary: summarizeCheckInRoster_((people || []).map(buildCheckInAttendeeResult_)),
    mealCount: parseInt(reg['meal_count']) || 0
  };
}

function adminPanelGetInventorySummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inventorySheet = ss.getSheetByName(CONFIG.sheets.lodgingInventory);
  const registrationsSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  const inventoryRows = [];
  const byCategory = {};

  if (inventorySheet && inventorySheet.getLastRow() > 1) {
    const rows = inventorySheet.getRange(2, 1, inventorySheet.getLastRow() - 1, inventorySheet.getLastColumn()).getValues();
    const colMap = getColumnMap_(inventorySheet);
    rows.forEach(row => {
      const category = String(row[colMap['lodging_category']] || '').trim();
      if (!category) return;
      const item = {
        category: category,
        label: String(row[colMap['label']] || category),
        used: parseInt(row[colMap['assigned_public_units']], 10) || 0,
        remaining: String(row[colMap['remaining_public_capacity']] || ''),
        capacity: row[colMap['public_capacity']] === '' ? '' : (parseInt(row[colMap['public_capacity']], 10) || 0),
        topBunks: parseInt(row[colMap['assigned_top_bunks']], 10) || 0,
        waitlist: parseInt(row[colMap['waitlist_count']], 10) || 0,
        manualReview: parseInt(row[colMap['manual_review_count']], 10) || 0,
        isUnlimited: String(row[colMap['is_unlimited']] || '').toLowerCase() === 'yes'
      };
      inventoryRows.push(item);
      byCategory[category] = item;
    });
  }

  const attention = {
    childWithoutGuardian: 0,
    waitlistedCabinRequests: 0,
    invalidLodgingChoice: 0,
    registrationsNeedingAttention: []
  };

  if (registrationsSheet && registrationsSheet.getLastRow() > 1) {
    const rows = registrationsSheet.getRange(2, 1, registrationsSheet.getLastRow() - 1, registrationsSheet.getLastColumn()).getValues();
    const colMap = getColumnMap_(registrationsSheet);
    rows.forEach(row => {
      const reg = {};
      Object.keys(colMap).forEach(key => { reg[key] = row[colMap[key]]; });
      const registrationId = String(reg['registration_id'] || '');
      if (!registrationId) return;
      const people = getAdminPeopleFromRosterByRegistration_(registrationId);
      const flags = buildAttentionFlagsForRegistration_(reg, people);
      if (!flags.length) return;
      flags.forEach(flag => {
        if (flag.code === 'child_without_guardian') attention.childWithoutGuardian++;
        if (flag.code === 'waitlisted_cabin') attention.waitlistedCabinRequests++;
        if (flag.code === 'invalid_lodging_choice') attention.invalidLodgingChoice++;
      });
      attention.registrationsNeedingAttention.push({
        registrationId: registrationId,
        registrationLabel: String(reg['registration_label'] || reg['club_name'] || reg['registrant_name'] || 'Registration'),
        primaryContactName: [reg['first_name'] || '', reg['last_name'] || ''].join(' ').trim() || String(reg['registrant_name'] || ''),
        lodgingPreference: String(reg['lodging_preference'] || ''),
        lodgingStatus: String(reg['lodging_status'] || ''),
        flags: flags
      });
    });
  }

  return {
    inventory: {
      cabinDetached: byCategory[CONFIG.lodging.categories.sharedCabinDetached.key] || null,
      cabinConnected: byCategory[CONFIG.lodging.categories.sharedCabinConnected.key] || null,
      rv: byCategory[CONFIG.lodging.categories.rvHookups.key] || null,
      tent: byCategory[CONFIG.lodging.categories.tentNoHookups.key] || null,
      sabbathOnly: byCategory[CONFIG.lodging.categories.sabbathOnly.key] || null,
      all: inventoryRows
    },
    attention: attention
  };
}

function adminPanelUpdateLodgingDetails(registrationId, payload) {
  try {
    if (!registrationId) return { success: false, message: 'Registration ID is required.' };
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
    if (!regSheet || !rosterSheet) return { success: false, message: 'Missing required sheets.' };

    const regRowIndex = findRegistrationRow_(regSheet, registrationId);
    if (regRowIndex < 0) return { success: false, message: 'Registration not found.' };

    const existingReg = readRowAsObject_(regSheet, regRowIndex);
    const people = readPeopleForRegistrationFromRoster_(rosterSheet, registrationId);
    if (!people.length) return { success: false, message: 'No attendees found for this registration.' };

    const attendeeUpdates = {};
    (payload.attendees || []).forEach(update => {
      attendeeUpdates[String(update.attendeeId || '')] = update;
    });

    const updatedPeople = people.map(person => {
      const override = attendeeUpdates[person.id] || {};
      return Object.assign({}, person, {
        isGuardian: override.isGuardian !== undefined ? toBoolean_(override.isGuardian) : person.isGuardian,
        guardianLinkKey: override.guardianLinkKey !== undefined ? String(override.guardianLinkKey || '').trim() : person.guardianLinkKey,
        guardianRegistrationId: override.guardianRegistrationId !== undefined ? String(override.guardianRegistrationId || '').trim() : person.guardianRegistrationId,
        lodgingPreference: override.lodgingPreference !== undefined
          ? normalizeLodgingPreference_(override.lodgingPreference)
          : person.lodgingPreference,
        lodgingStatus: override.lodgingStatus !== undefined
          ? normalizeAdminChoice_(override.lodgingStatus, CONFIG.lodging.validation.validStatuses, person.lodgingStatus || 'pending')
          : person.lodgingStatus,
        bunkType: override.bunkType !== undefined
          ? normalizeAdminChoice_(override.bunkType, CONFIG.lodging.validation.validBunkTypes, person.bunkType || 'none')
          : person.bunkType,
        assignedLodgingArea: override.assignedLodgingArea !== undefined ? String(override.assignedLodgingArea || '').trim() : person.assignedLodgingArea,
        notes: override.notes !== undefined ? String(override.notes || '').trim() : person.notes,
        consumesPublicInventory: override.consumesPublicInventory !== undefined
          ? toBoolean_(override.consumesPublicInventory)
          : !!person.consumesPublicInventory,
        inventoryCategory: override.inventoryCategory !== undefined
          ? normalizeLodgingPreference_(override.inventoryCategory)
          : (person.inventoryCategory || person.lodgingPreference || ''),
        assignmentReason: override.assignmentReason !== undefined ? String(override.assignmentReason || '').trim() : (person.assignmentReason || '')
      });
    });

    const registrationPreference = payload.lodgingPreference !== undefined
      ? normalizeLodgingPreference_(payload.lodgingPreference)
      : normalizeLodgingPreference_(existingReg['lodging_preference'] || updatedPeople[0].lodgingPreference || '');
    const assignedLodgingArea = payload.assignedLodgingArea !== undefined
      ? String(payload.assignedLodgingArea || '').trim()
      : String(existingReg['assigned_lodging_area'] || '');

    // Manual lodging updates are intentionally explicit and auditable; they do
    // not silently rerun assignment logic because staff may be overriding it.
    const assigned = {
      registrationId: registrationId,
      registrationLabel: String(existingReg['registration_label'] || existingReg['club_name'] || existingReg['registrant_name'] || 'Registration'),
      registrantName: [existingReg['first_name'] || '', existingReg['last_name'] || ''].join(' ').trim() || String(existingReg['registrant_name'] || ''),
      registrantEmail: String(existingReg['email'] || existingReg['registrant_email'] || ''),
      registrantPhone: String(existingReg['phone'] || existingReg['registrant_phone'] || ''),
      lodgingPreference: registrationPreference,
      lodgingStatus: payload.lodgingStatus !== undefined
        ? normalizeAdminChoice_(payload.lodgingStatus, CONFIG.lodging.validation.validStatuses, deriveRegistrationLodgingStatus_(updatedPeople))
        : deriveRegistrationLodgingStatus_(updatedPeople),
      assignedLodgingArea: assignedLodgingArea,
      notes: payload.notes !== undefined ? String(payload.notes || '').trim() : String(existingReg['notes'] || ''),
      bunkTypeSummary: deriveBunkTypeSummary_(updatedPeople),
      guardianLinkSummary: updatedPeople.map(p => p.guardianLinkKey).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', '),
      createdAt: existingReg['created_at'] || existingReg['timestamp'] || new Date(),
      timestamp: existingReg['timestamp'] || new Date(),
      people: updatedPeople,
      roster: updatedPeople
    };

    persistLodgingAssignments_(ss, assigned);
    updateRegistrationAndRosterLodgingFields_(ss, regSheet, rosterSheet, regRowIndex, assigned);
    updateSummaryRowsForRegistration_(ss, assigned);
    refreshLodgingInventorySheet_(ss);

    return { success: true, message: 'Lodging details updated for ' + registrationId + '.' };
  } catch (e) {
    return { success: false, message: 'Error: ' + e.message };
  }
}

function buildAdminRosterPerson_(person) {
  const guardianSummary = person.isGuardian
    ? 'Guardian'
    : (person.guardianLinkKey ? 'Child linked by key: ' + person.guardianLinkKey : (person.guardianRegistrationId ? 'Child linked to ' + person.guardianRegistrationId : 'No guardian link'));
  return {
    attendeeId: person.id || '',
    name: person.name || '',
    firstName: person.firstName || '',
    lastName: person.lastName || '',
    email: person.email || '',
    phone: person.phone || '',
    age: person.age || '',
    gender: person.gender || '',
    role: person.role || (person.ageGroup === 'child' ? 'child' : 'adult'),
    ageGroup: person.ageGroup || '',
    isGuardian: !!person.isGuardian,
    guardianLinkKey: person.guardianLinkKey || '',
    guardianRegistrationId: person.guardianRegistrationId || '',
    guardianSummary: guardianSummary,
    lodgingPreference: person.lodgingPreference || '',
    lodgingStatus: person.lodgingStatus || 'pending',
    bunkType: person.bunkType || 'none',
    assignedLodgingArea: person.assignedLodgingArea || '',
    notes: person.notes || '',
    checkInStatus: String(person.checkInStatus || '').toLowerCase(),
    checkInTimestamp: person.checkInTimestamp || '',
    checkInTimestampDisplay: person.checkInTimestamp ? formatCheckInTimestamp_(person.checkInTimestamp) : '',
    dietary: person.dietaryRestrictions || '',
    isMedical: !!person.isMedicalPersonnel,
    isMasterGuide: !!person.isMasterGuideInvestiture,
    isFirstTime: !!person.isFirstTime,
    assignmentReason: person.assignmentReason || ''
  };
}

function buildAttentionFlagsForRegistration_(registrationRow, people) {
  const flags = [];
  const preference = normalizeLodgingPreference_(registrationRow['lodging_preference'] || '');
  const status = String(registrationRow['lodging_status'] || deriveRegistrationLodgingStatus_(people)).toLowerCase();

  if (!CONFIG.lodging.validation.validPreferences.includes(preference)) {
    flags.push({
      code: 'invalid_lodging_choice',
      label: 'Invalid lodging choice',
      detail: 'Registration has an unknown lodging preference and needs manual review.'
    });
  }

  if ((preference === CONFIG.lodging.categories.sharedCabinDetached.key || preference === CONFIG.lodging.categories.sharedCabinConnected.key) && status === 'waitlist') {
    flags.push({
      code: 'waitlisted_cabin',
      label: 'Waitlisted cabin request',
      detail: 'Cabin request exceeded bottom-bunk inventory.'
    });
  }

  if (people.some(person => person.ageGroup === 'child' && !person.isGuardian && !person.guardianLinkKey && !person.guardianRegistrationId)) {
    flags.push({
      code: 'child_without_guardian',
      label: 'Child without guardian',
      detail: 'At least one child lacks a guardian link and cannot be auto-assigned a cabin bunk.'
    });
  }

  if (people.some(person => person.lodgingStatus === 'manual_review')) {
    flags.push({
      code: 'manual_review',
      label: 'Manual review required',
      detail: 'One or more attendees need staff review before lodging is finalized.'
    });
  }

  return flags;
}

function getAdminPeopleFromRosterByRegistration_(registrationId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!rosterSheet) return [];
  return readPeopleForRegistrationFromRoster_(rosterSheet, registrationId);
}

function normalizeAdminChoice_(value, validValues, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return validValues.includes(normalized) ? normalized : fallback;
}

function formatAdminLodgingSummary_(preference, status) {
  const parts = [];
  if (preference) parts.push(preference.replace(/_/g, ' '));
  if (status) parts.push(status.replace(/_/g, ' '));
  return parts.join(' · ');
}


// ============================================================
// SECTION 4 — RESEND CONFIRMATION EMAIL
// ============================================================

/**
 * Resends Email 1 (confirmation) for a given registration ID.
 * Mirrors the logic of adminResendConfirmationEmail() but is
 * callable from the sidebar (returns a result object instead of
 * showing UI alerts).
 *
 * @param  {string} registrationId
 * @returns {Object} { success: boolean, message: string }
 */
function adminPanelResendEmail(registrationId) {
  try {
    const ss       = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    if (!regSheet) return { success: false, message: 'Registrations sheet not found.' };

    // Find the registration row
    const regData = regSheet.getDataRange().getValues();
    const col     = {};
    regData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { col[h] = i; });

    let regRow = null;
    for (let r = 1; r < regData.length; r++) {
      if (String(regData[r][col['registrationid']] || '') === registrationId) {
        regRow = regData[r];
        break;
      }
    }
    if (!regRow) return { success: false, message: 'Registration not found: ' + registrationId };

    const val = c => (regRow[col[c.toLowerCase().replace(/[^a-z0-9]/g, '')]] !== undefined ? regRow[col[c.toLowerCase().replace(/[^a-z0-9]/g, '')]] : '');

    const emailData = buildConfirmationEmailDataFromRegistration_(ss, registrationId);
    sendConfirmationEmail_(emailData);
    logEmail_(ss, registrationId, emailData.registrantEmail, emailData.registrationLabel, 'email1_resent', '');

    return { success: true, message: 'Confirmation email resent to ' + emailData.registrantEmail + '.' };
  } catch (err) {
    return { success: false, message: 'Error: ' + err.toString() };
  }
}


// ============================================================
// SECTION 5 — DELETE REGISTRATION
// ============================================================

/**
 * Deletes all data for a registration across every sheet.
 * Removes rows from: Registrations, Roster, CampingGroups, Assignments.
 * Regenerates report sheets afterward.
 *
 * @param  {string} registrationId
 * @returns {Object} { success: boolean, message: string }
 */
function adminPanelDeleteRegistration(registrationId) {
  try {
    if (!registrationId) return { success: false, message: 'No registration ID provided.' };

    const ss           = SpreadsheetApp.getActiveSpreadsheet();
    let   totalDeleted = 0;

    const sheetTargets = [
      CONFIG.sheets.registrations,
      CONFIG.sheets.roster,
      CONFIG.sheets.campingGroups,
      CONFIG.sheets.assignments,
      CONFIG.sheets.lodgingAssignments,
    ];

    sheetTargets.forEach(sheetName => {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet || sheet.getLastRow() < 2) return;

      const colIndex = getColumnNumber_(sheet, 'registration_id');
      if (colIndex < 0) {
        Logger.log('adminPanelDeleteRegistration: registration_id column not found in ' + sheetName);
        return;
      }

      const ids = sheet.getRange(2, colIndex, sheet.getLastRow() - 1, 1).getValues().flat();
      // Delete bottom-to-top so row indices stay valid
      for (let i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i]) === registrationId) {
          sheet.deleteRow(i + 2);  // +2: header row offset + 0-to-1 base
          totalDeleted++;
        }
      }
    });

    refreshLodgingInventorySheet_(ss);

    // Regenerate reports (non-fatal if it fails)
    try { generateAllReportSheets(); } catch (e) { /* non-fatal */ }

    return {
      success: true,
      message: 'Registration ' + registrationId + ' deleted. Removed ' + totalDeleted + ' row(s) across all sheets.',
    };
  } catch (err) {
    return { success: false, message: 'Error: ' + err.toString() };
  }
}


// ============================================================
// SECTION 6 — ADD ATTENDEE
// ============================================================

/**
 * Adds a new person to an existing registration's roster and
 * updates the registration snapshot and lodging state.
 *
 * @param  {string} registrationId
 * @param  {Object} attendeeData  person fields from the admin sidebar
 * @returns {Object} { success: boolean, message: string, attendeeId?: string }
 */
function adminPanelAddAttendee(registrationId, attendeeData) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── Find registration row ───────────────────────────────────────────────
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    if (!regSheet) return { success: false, message: 'Registrations sheet not found.' };

    const regData = regSheet.getDataRange().getValues();
    const regCol  = {};
    regData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { regCol[h] = i; });

    let regRow      = null;
    let regRowIndex = -1;
    for (let r = 1; r < regData.length; r++) {
      if (String(regData[r][regCol['registrationid']] || '') === registrationId) {
        regRow      = regData[r];
        regRowIndex = r + 1;  // 1-based sheet row number
        break;
      }
    }
    if (!regRow) return { success: false, message: 'Registration not found: ' + registrationId };

    const registrationLabel = String(regRow[regCol['registrationlabel']] || regRow[regCol['clubname']] || regRow[regCol['registrantname']] || 'Registration');
    const registrantEmail = String(regRow[regCol['registrantemail']]|| '');
    const registrantPhone = String(regRow[regCol['registrantphone']]|| '');

    // ── Generate attendee ID (person prefix + next sequential number) ───────
    const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
    if (!rosterSheet) return { success: false, message: 'Roster sheet not found.' };

    const ageGroup = normalizeAdminChoice_(
      attendeeData.ageGroup !== undefined ? attendeeData.ageGroup : (String(attendeeData.role || '').toLowerCase() === 'child' ? 'child' : 'adult'),
      ['adult', 'child'],
      'adult'
    );
    const isGuardian = attendeeData.isGuardian !== undefined ? toBoolean_(attendeeData.isGuardian) : ageGroup === 'adult';
    const role = ageGroup === 'child' ? 'child' : (isGuardian ? 'guardian' : 'adult');
    const prefixes = { adult: 'ADULT', guardian: 'GUARD', child: 'CHILD' };
    const prefix   = prefixes[role] || 'ATT';

    let maxNum = 0;
    if (rosterSheet.getLastRow() > 1) {
      const rData = rosterSheet.getDataRange().getValues();
      const rCol  = {};
      rData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { rCol[h] = i; });

      for (let r = 1; r < rData.length; r++) {
        const aId = String(rData[r][rCol['attendeeid']] || '');
        if (aId.startsWith(prefix + '-')) {
          const num = parseInt(aId.split('-')[1], 10) || 0;
          if (num > maxNum) maxNum = num;
        }
      }
    }
    const attendeeId = prefix + '-' + String(maxNum + 1).padStart(3, '0');

    // ── Append roster row ───────────────────────────────────────────────────
    const fullName = String(attendeeData.name || '').trim();
    const split = splitName_(fullName);
    const lodgingPreference = normalizeLodgingPreference_(attendeeData.lodgingPreference || regRow[regCol['lodgingpreference']] || 'tent_no_hookups');

    appendRowFromObject_(rosterSheet, {
      registration_id: registrationId,
      attendee_id: attendeeId,
      attendee_name: fullName,
      age: parseInt(attendeeData.age, 10) || '',
      gender: String(attendeeData.gender || ''),
      role: role,
      participation_status: attendeeData.isFirstTime ? 'first-time' : 'returning',
      dietary_restrictions: String(attendeeData.dietary || ''),
      is_medical_personnel: attendeeData.isMedical ? 'Yes' : 'No',
      is_master_guide_investiture: attendeeData.isMasterGuide ? 'Yes' : 'No',
      is_first_time: attendeeData.isFirstTime ? 'Yes' : 'No',
      counts_toward_billing: ageGroup === 'child' ? 'No' : 'Yes',
      club_name: registrationLabel,
      registrant_email: registrantEmail,
      timestamp: new Date(),
      first_name: split.firstName,
      last_name: split.lastName,
      email: String(attendeeData.email || registrantEmail || ''),
      phone: String(attendeeData.phone || registrantPhone || ''),
      age_group: ageGroup,
      is_guardian: isGuardian ? 'Yes' : 'No',
      guardian_registration_id: String(attendeeData.guardianRegistrationId || ''),
      guardian_link_key: String(attendeeData.guardianLinkKey || ''),
      lodging_preference: lodgingPreference,
      lodging_status: 'pending',
      bunk_type: 'none',
      assigned_lodging_area: '',
      notes: '',
      created_at: new Date(),
    });

    // ── Update headcount in Registrations row ───────────────────────────────
    const roleCountCols = {
      adult: 'totalstaff',
      guardian: 'totalstaff',
      child: 'totalchildren',
    };
    const roleCol = roleCountCols[role];
    if (roleCol && regCol[roleCol] !== undefined) {
      const current = parseInt(regRow[regCol[roleCol]], 10) || 0;
      regSheet.getRange(regRowIndex, regCol[roleCol] + 1).setValue(current + 1);
    }
    if (regCol['totalattendees'] !== undefined) {
      const current = parseInt(regRow[regCol['totalattendees']], 10) || 0;
      regSheet.getRange(regRowIndex, regCol['totalattendees'] + 1).setValue(current + 1);
    }

    // ── Rebuild roster_json, recalculate estimated_total, and refresh lodging ─────
    syncRosterSnapshotAndTotal_(ss, rosterSheet, regSheet, registrationId, regRowIndex, regRow, regCol);

    // Regenerate reports (non-fatal)
    try { generateAllReportSheets(); } catch (e) { /* non-fatal */ }

    return {
      success:     true,
      message:     'Added ' + attendeeData.name + ' (' + attendeeId + ') to ' + registrationLabel + '.',
      attendeeId:  attendeeId,
    };
  } catch (err) {
    return { success: false, message: 'Error: ' + err.toString() };
  }
}


// ============================================================
// SECTION 7 — REMOVE ATTENDEE
// ============================================================

/**
 * Removes a single attendee from the Roster sheet and decrements
 * the headcount in the Registrations sheet.
 *
 * @param  {string} registrationId
 * @param  {string} attendeeId     — e.g. "PATH-003"
 * @returns {Object} { success: boolean, message: string }
 */
function adminPanelRemoveAttendee(registrationId, attendeeId) {
  try {
    const ss          = SpreadsheetApp.getActiveSpreadsheet();
    const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
    if (!rosterSheet) return { success: false, message: 'Roster sheet not found.' };

    if (rosterSheet.getLastRow() < 2) {
      return { success: false, message: 'Roster sheet is empty.' };
    }

    const rData = rosterSheet.getDataRange().getValues();
    const rCol  = {};
    rData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { rCol[h] = i; });

    let rowToDelete  = -1;
    let removedRole  = '';
    let removedName  = '';

    for (let r = 1; r < rData.length; r++) {
      if (
        String(rData[r][rCol['registrationid']] || '') === registrationId &&
        String(rData[r][rCol['attendeeid']]     || '') === attendeeId
      ) {
        rowToDelete = r + 1;  // 1-based
        removedRole = String(rData[r][rCol['role']]          || '').toLowerCase();
        removedName = String(rData[r][rCol['attendeename']] || '');
        break;
      }
    }

    if (rowToDelete === -1) {
      return { success: false, message: 'Attendee ' + attendeeId + ' not found in registration ' + registrationId + '.' };
    }

    rosterSheet.deleteRow(rowToDelete);

    // ── Decrement headcount in Registrations ────────────────────────────────
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    if (regSheet && regSheet.getLastRow() > 1) {
      const regData = regSheet.getDataRange().getValues();
      const regCol  = {};
      regData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { regCol[h] = i; });

      for (let r = 1; r < regData.length; r++) {
        if (String(regData[r][regCol['registrationid']] || '') !== registrationId) continue;

        const rowNum = r + 1;
        const roleCountCols = {
          adult:      'totalstaff',
          guardian:   'totalstaff',
          child:      'totalchildren',
          pathfinder: 'totalpathfinders',
          tlt:        'totaltlt',
          staff:      'totalstaff',
        };
        const roleCol = roleCountCols[removedRole];
        if (roleCol && regCol[roleCol] !== undefined) {
          const current = parseInt(regData[r][regCol[roleCol]], 10) || 0;
          regSheet.getRange(rowNum, regCol[roleCol] + 1).setValue(Math.max(0, current - 1));
        }
        if (regCol['totalattendees'] !== undefined) {
          const current = parseInt(regData[r][regCol['totalattendees']], 10) || 0;
          regSheet.getRange(rowNum, regCol['totalattendees'] + 1).setValue(Math.max(0, current - 1));
        }
        break;
      }
    }

    // ── Rebuild roster_json, recalculate estimated_total, and refresh lodging ─────
    // Re-read regSheet data after headcount changes so regRow values are fresh
    const regData2 = regSheet.getDataRange().getValues();
    const regCol2  = {};
    regData2[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { regCol2[h] = i; });
    let regRow2 = null, regRowIndex2 = -1;
    for (let r = 1; r < regData2.length; r++) {
      if (String(regData2[r][regCol2['registrationid']] || '') === registrationId) {
        regRow2 = regData2[r]; regRowIndex2 = r + 1; break;
      }
    }
    if (regRow2) {
      syncRosterSnapshotAndTotal_(ss, rosterSheet, regSheet, registrationId, regRowIndex2, regRow2, regCol2);
    }

    // Regenerate reports (non-fatal)
    try { generateAllReportSheets(); } catch (e) { /* non-fatal */ }

    return {
      success: true,
      message: 'Removed ' + removedName + ' (' + attendeeId + ') from registration.',
    };
  } catch (err) {
    return { success: false, message: 'Error: ' + err.toString() };
  }
}

// ============================================================
// SECTION 7b — ROSTER SNAPSHOT SYNC HELPER
// ============================================================

/**
 * After any roster mutation (add or remove attendee), call this to:
 *   1. Re-read all roster rows for the registration and serialize to JSON.
 *   2. Write the new roster_json back to the Registrations sheet so that
 *      email resends and any future resyncs reflect the current roster.
 *   3. Recalculate estimated_total using calculateCost_() and write it back.
 *   4. Rebuild lodging assignments and inventory summary for the registration.
 *
 * This is a shared helper used by both adminPanelAddAttendee() and
 * adminPanelRemoveAttendee() to ensure both operations stay in sync.
 *
 * @param {Spreadsheet} ss
 * @param {Sheet}       rosterSheet
 * @param {Sheet}       regSheet
 * @param {string}      registrationId
 * @param {number}      regRowIndex     — 1-based row number in regSheet
 * @param {Array}       regRow          — raw values array for that row
 * @param {Object}      regCol          — normalized column name → index map
 */
function syncRosterSnapshotAndTotal_(ss, rosterSheet, regSheet, registrationId, regRowIndex, regRow, regCol) {
  try {
    // Re-read all current roster rows for this registration
    const rData = rosterSheet.getDataRange().getValues();
    const rCol  = {};
    rData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { rCol[h] = i; });

    const rosterSnapshot = [];
    for (let r = 1; r < rData.length; r++) {
      const row = rData[r];
      if (String(row[rCol['registrationid']] || '') !== registrationId) continue;

      const isFirstTime =
        String(row[rCol['participationstatus']] || '').toLowerCase() === 'first-time' ||
        String(row[rCol['isfirsttime']]         || '').toLowerCase() === 'yes';

      rosterSnapshot.push({
        id:                       String(row[rCol['attendeeid']]              || ''),
        name:                     String(row[rCol['attendeename']]            || ''),
        role:                     String(row[rCol['role']]                     || '').toLowerCase(),
        age:                      row[rCol['age']] || '',
        gender:                   String(row[rCol['gender']]                   || ''),
        status:                   String(row[rCol['participationstatus']]     || '').toLowerCase(),
        dietaryRestrictions:      String(row[rCol['dietaryrestrictions']]     || ''),
        isMedicalPersonnel:       String(row[rCol['ismedicalpersonnel']]      || '').toLowerCase() === 'yes',
        isMasterGuideInvestiture: String(row[rCol['ismasterguideinvestiture']] || '').toLowerCase() === 'yes',
        isFirstTime:              isFirstTime,
        firstName:                String(row[rCol['firstname']] || ''),
        lastName:                 String(row[rCol['lastname']] || ''),
        email:                    String(row[rCol['email']] || row[rCol['registrantemail']] || ''),
        phone:                    String(row[rCol['phone']] || ''),
        ageGroup:                 String(row[rCol['agegroup']] || (String(row[rCol['role']] || '').toLowerCase() === 'child' ? 'child' : 'adult')),
        isGuardian:               String(row[rCol['isguardian']] || '').toLowerCase() === 'yes',
        guardianRegistrationId:   String(row[rCol['guardianregistrationid']] || ''),
        guardianLinkKey:          String(row[rCol['guardianlinkkey']] || ''),
        lodgingPreference:        String(row[rCol['lodgingpreference']] || ''),
        lodgingStatus:            String(row[rCol['lodgingstatus']] || ''),
        bunkType:                 String(row[rCol['bunktype']] || ''),
        assignedLodgingArea:      String(row[rCol['assignedlodgingarea']] || ''),
        notes:                    String(row[rCol['notes']] || '')
      });
    }

    // Write updated roster_json
    const rosterJsonCol = getColumnNumber_(regSheet, 'roster_json');
    if (rosterJsonCol > 0) {
      regSheet.getRange(regRowIndex, rosterJsonCol).setValue(JSON.stringify(rosterSnapshot));
    }

    // Recalculate and write estimated_total
    const ts      = regRow[regCol['timestamp']];
    const mealCt  = parseInt(regRow[regCol['mealcount']] !== undefined ? regRow[regCol['mealcount']] : (regRow[regCol['mealct']] || 0), 10) || 0;
    const newCost = calculateCost_(rosterSnapshot, ts ? new Date(ts) : new Date(), mealCt);
    const totalCol = getColumnNumber_(regSheet, 'estimated_total');
    if (totalCol > 0) {
      regSheet.getRange(regRowIndex, totalCol).setValue(newCost.estimatedTotal);
    }

    rebuildLodgingStateForRegistration_(ss, registrationId);
  } catch (e) {
    Logger.log('syncRosterSnapshotAndTotal_: non-fatal error: ' + e);
  }
}


// ============================================================
// SECTION 8 — PDF GENERATION (Admin Panel)
// ============================================================

/**
 * Generates a PDF for a single registration and returns the sharable
 * Google Drive URL.  Called from AdminSidebar.html via google.script.run.
 *
 * Delegates to generatePdfForRow_() for all PDF-building logic, then
 * sets the file's sharing permissions so it can be opened via the URL.
 *
 * @param  {string} registrationId  e.g. 'REG-2026-543ABC'
 * @returns {string}                Public Drive URL of the generated PDF
 */
function adminPanelGeneratePDF(registrationId) {
  if (!registrationId) throw new Error('No registration ID provided.');

  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!regSheet) throw new Error('Registrations sheet not found.');

  const targetRow = findRegistrationRow_(regSheet, registrationId);
  if (targetRow < 0) throw new Error('Registration not found: ' + registrationId);

  // Assuming generatePdfForRow_ is available in the global scope (generateRegistrationPDF.gs)
  const result  = generatePdfForRow_(ss, regSheet, targetRow);
  const pdfFile = DriveApp.getFileById(result.fileId);

  // Make it accessible to anyone with the link
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return pdfFile.getUrl();
}

// ============================================================
// SECTION 9 — SYSTEM TOOLS
// ============================================================

// ============================================================
// SECTION 9b — ASSIGNMENT TOOLS
// ============================================================

/**
 * Returns a lodging queue for registrations that need assignment work.
 *
 * The old assignment manager UI is now reused as a lodging queue so staff can
 * quickly jump into waitlisted or manual-review registrations.
 */
function adminPanelGetAllAssignments() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    if (!regSheet || regSheet.getLastRow() < 2) {
      return { clubs: [], totalClubs: 0, assignedCount: 0, fullyAssignedCount: 0 };
    }

    const rData = regSheet.getDataRange().getValues();
    const rCol = {};
    rData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { rCol[h] = i; });

    const clubs = [];
    let assignedCount = 0, fullyAssignedCount = 0;

    for (let r = 1; r < rData.length; r++) {
      const row = rData[r];
      const regId = String(row[rCol['registrationid']] || '');
      if (!regId) continue;
      const reg = {};
      Object.keys(rCol).forEach(key => { reg[key] = row[rCol[key]]; });
      const people = getAdminPeopleFromRosterByRegistration_(regId);
      const flags = buildAttentionFlagsForRegistration_(reg, people);
      const lodgingStatus = String(reg['lodging_status'] || '').toLowerCase();
      const hasAnything = lodgingStatus === 'assigned' || lodgingStatus === 'waitlist' || lodgingStatus === 'manual_review';
      const fullyAssigned = lodgingStatus === 'assigned';
      if (hasAnything) assignedCount++;
      if (fullyAssigned) fullyAssignedCount++;
      clubs.push({
        registrationId: regId,
        clubName: String(reg['registration_label'] || reg['club_name'] || reg['registrant_name'] || 'Registration'),
        directorEmail: String(reg['email'] || reg['registrant_email'] || ''),
        campingLocation: String(reg['assigned_lodging_area'] || ''),
        lodgingPreference: String(reg['lodging_preference'] || ''),
        lodgingStatus: lodgingStatus,
        totalAttendees: people.length || (parseInt(reg['total_attendees'], 10) || 0),
        estimatedTotal: parseFloat(reg['estimated_total']) || 0,
        registrationTimestamp: reg['timestamp'] || null,
        notes: String(reg['notes'] || ''),
        attentionFlags: flags,
        email2Sent: false,
        isFullyAssigned:     fullyAssigned,
        isPartiallyAssigned: hasAnything && !fullyAssigned,
        isUnassigned:        !hasAnything,
      });
    }

    // Sort by registration timestamp (order clubs registered), matching Registrations sheet order
    clubs.sort((a, b) => {
      const ta = a.registrationTimestamp ? new Date(a.registrationTimestamp).getTime() : Infinity;
      const tb = b.registrationTimestamp ? new Date(b.registrationTimestamp).getTime() : Infinity;
      return ta !== tb ? ta - tb : a.clubName.localeCompare(b.clubName);
    });

    return {
      clubs:              clubs,
      totalClubs:         clubs.length,
      assignedCount:      assignedCount,
      fullyAssignedCount: fullyAssignedCount,
    };
  } catch (err) {
    return { error: err.toString(), clubs: [], totalClubs: 0, assignedCount: 0, fullyAssignedCount: 0 };
  }
}

/**
 * Saves assignment fields for one club to the Assignments sheet.
 * Only writes fields that are provided in the `assignments` object —
 * missing keys leave existing cell values untouched.
 *
 * Supported keys in `assignments`:
 *   dutyAssigned, dutyTimeDay, specialActivityAssigned,
 *   activityDetail, campingLocation, campingNotes
 *
 * @param  {string} registrationId
 * @param  {Object} assignments     — partial or full assignment data
 * @returns {Object} { success, message }
 */
function adminPanelSetAssignment(registrationId, assignments) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.sheets.assignments);
    if (!sheet) return { success: false, message: 'Assignments sheet not found.' };

    const data = sheet.getDataRange().getValues();
    const col  = {};
    data[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { col[h] = i; });

    let rowNum = -1;
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][col['registrationid']] || '') === registrationId) {
        rowNum = r + 1;  // 1-based
        break;
      }
    }
    if (rowNum < 0) return { success: false, message: 'Registration not found: ' + registrationId };

    // Map JS camelCase keys to sheet column header names
    const fieldMap = {
      dutyAssigned:            'duty_assigned',
      dutyTimeDay:             'duty_time_day',
      specialActivityAssigned: 'special_activity_assigned',
      activityDetail:          'activity_detail',
      campingLocation:         'camping_location',
      campingNotes:            'camping_notes',
    };

    for (const [jsKey, colName] of Object.entries(fieldMap)) {
      if (assignments[jsKey] !== undefined) {
        const colIdx = getColumnNumber_(sheet, colName);
        if (colIdx > 0) {
          sheet.getRange(rowNum, colIdx).setValue(assignments[jsKey]);
        }
      }
    }

    return { success: true, message: 'Assignment saved for ' + registrationId + '.' };
  } catch (err) {
    return { success: false, message: 'Error: ' + err.toString() };
  }
}


function adminGenerateClubDashboards() {
  try {
    const count = generateClubDashboardSheet();
    return { success: true, message: 'Generated registration dashboard for ' + count + ' registrations.' };
  } catch (e) {
    return { success: false, message: 'Error: ' + e.message };
  }
}

function adminGenerateCampingCoordinatorSummary() {
  try {
    const count = generateCampingCoordinatorSheet();
    return { success: true, message: 'Generated lodging inventory summary with ' + count + ' lodging categories.' };
  } catch (e) {
    return { success: false, message: 'Error: ' + e.message };
  }
}

function adminValidateDataIntegrity() {
  try {
    // Re-use logic from Code.gs validateDataIntegrity but return text instead of UI alert
    const ss       = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    const rstSheet = ss.getSheetByName(CONFIG.sheets.roster);

    if (!regSheet || !rstSheet) return { success: false, message: 'Missing required sheets.' };

    const regIds = regSheet.getLastRow() > 1
      ? regSheet.getRange(2, getColumnNumber_(regSheet, 'registration_id'), regSheet.getLastRow() - 1, 1).getValues().flat()
      : [];
    const rosterIds = rstSheet.getLastRow() > 1
      ? rstSheet.getRange(2, getColumnNumber_(rstSheet, 'registration_id'), rstSheet.getLastRow() - 1, 1).getValues().flat()
      : [];

    const orphaned  = rosterIds.filter(id => id && !regIds.includes(id));
    const rosterSet = new Set(rosterIds);
    const missing   = regIds.filter(id => id && !rosterSet.has(id));

    return {
      success: true,
      message: `Integrity Check:\n` +
               `• ${orphaned.length} orphaned roster rows\n` +
               `• ${missing.length} registrations without roster rows`
    };
  } catch (e) {
    return { success: false, message: 'Error: ' + e.message };
  }
}

function adminFindDuplicates() {
  try {
    // Re-use logic from Code.gs adminFindDuplicates but return text
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.sheets.registrations);
    if (!sheet || sheet.getLastRow() < 3) return { success: true, message: 'Not enough data to check.' };

    const colMap  = {};
    const data    = sheet.getDataRange().getValues();
    data[0].forEach((h, i) => { colMap[String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '')] = i; });

    const entryIds = {};
    let dupesCount = 0;

    for (let i = 1; i < data.length; i++) {
      const eid = String(data[i][colMap['fluentformentryid']] || '');
      if (eid && eid !== 'undefined') {
        if (entryIds[eid]) dupesCount++;
        else entryIds[eid] = true;
      }
    }

    return {
      success: true,
      message: dupesCount === 0 ? 'No duplicates found.' : `Found ${dupesCount} potential duplicates.`
    };
  } catch (e) {
    return { success: false, message: 'Error: ' + e.message };
  }
}

// ============================================================
// SECTION 10 — FINANCIALS
// ============================================================

/**
 * Manually updates the Estimated Total for a registration.
 */
function adminPanelUpdateEstimatedTotal(registrationId, newTotal) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    const row = findRegistrationRow_(regSheet, registrationId);
    if (row < 0) return { success: false, message: 'Registration not found.' };

    const colNum = getColumnNumber_(regSheet, 'estimated_total');
    if (colNum < 0) return { success: false, message: 'Column estimated_total not found.' };

    regSheet.getRange(row, colNum).setValue(newTotal);
    return { success: true, message: 'Updated estimated total to ' + newTotal };
  } catch (e) {
    return { success: false, message: 'Error: ' + e.message };
  }
}

/**
 * Legacy compatibility action. Man Camp pricing no longer uses a meal discount.
 */
function adminPanelRevokeMealDiscount(registrationId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    const row = findRegistrationRow_(regSheet, registrationId);
    if (row < 0) return { success: false, message: 'Registration not found.' };

    const mealCol = getColumnNumber_(regSheet, 'meal_count');
    const totalCol = getColumnNumber_(regSheet, 'estimated_total');
    const optionPriceCol = getColumnNumber_(regSheet, 'price_selected');
    const newTotal = optionPriceCol > 0 ? Number(regSheet.getRange(row, optionPriceCol).getValue()) || 0 : 0;

    // Write back
    regSheet.getRange(row, mealCol).setValue(0);
    regSheet.getRange(row, totalCol).setValue(newTotal);

    return {
      success: true,
      message: `Meal discount is not used for Man Camp. Total left at $${newTotal}.`
    };
  } catch (e) {
    return { success: false, message: 'Error: ' + e.message };
  }
}

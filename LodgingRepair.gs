// ============================================================
// Man Camp Registration System
// Google Apps Script — LodgingRepair.gs
// Repairs lodging data for existing registrations using price
// evidence, and provides a read-only audit mode.
// ============================================================


// ============================================================
// SECTION 1 — PRICE ↔ KEY HELPERS
// ============================================================

/**
 * Returns the lodging key whose configured price is within $0.50 of
 * perPersonPrice, or null if no match is found.
 *
 * @param  {number} perPersonPrice
 * @returns {string|null}
 */
function lodgingKeyFromPerPersonPrice_(perPersonPrice) {
  const price = Number(perPersonPrice);
  if (isNaN(price)) return null;
  const tolerance = 0.50;
  const opts = CONFIG.registrationOptions;
  const keys = Object.keys(opts);
  for (var i = 0; i < keys.length; i++) {
    const key = keys[i];
    const configPrice = Number(opts[key].price);
    if (Math.abs(configPrice - price) <= tolerance) return key;
  }
  return null;
}

/**
 * Returns the human-readable label for a lodging key from CONFIG.
 *
 * @param  {string} key
 * @returns {string}
 */
function lodgingLabelFromKey_(key) {
  const opt = CONFIG.registrationOptions[key];
  return opt ? (opt.label || key) : key;
}


// ============================================================
// SECTION 2 — PUBLIC ENTRY POINTS
// ============================================================

/**
 * Previews the lodging repair in read-only mode.
 * Writes the LodgingRepairLog sheet but makes no data changes.
 */
function runLodgingAuditOnly_() {
  repairOrAuditLodgingInternal_(/* dryRun= */ true);
}

/**
 * Repairs lodging for all AUTO-FIXABLE registrations based on
 * per-person price evidence.
 *
 * Shows a confirmation dialog before running. Uses LockService to
 * prevent concurrent executions. Calls refreshLodgingInventorySheet_()
 * once at the end if any rows were repaired.
 */
function repairLodgingFromPrice_() {
  const ui = SpreadsheetApp.getUi();
  const btn = ui.alert(
    'Repair Lodging from Price Data',
    'This will update lodging for all AUTO-FIXABLE registrations based on ' +
    'payment amounts. Review the LodgingRepairLog sheet after running. ' +
    'This cannot be undone automatically. Proceed?',
    ui.ButtonSet.YES_NO
  );
  if (btn !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    ui.alert('⚠️ Another lodging repair operation is already running. Please try again in a moment.');
    return;
  }
  try {
    repairOrAuditLodgingInternal_(/* dryRun= */ false);
  } finally {
    lock.releaseLock();
  }
}


// ============================================================
// SECTION 3 — CORE AUDIT / REPAIR LOGIC
// ============================================================

/**
 * Core implementation shared by repairLodgingFromPrice_() and
 * runLodgingAuditOnly_().
 *
 * @param {boolean} dryRun — true = read-only audit, false = write repairs
 */
function repairOrAuditLodgingInternal_(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet            = ss.getSheetByName(CONFIG.sheets.registrations);
  const rosterSheet         = ss.getSheetByName(CONFIG.sheets.roster);
  const campingSheet        = ss.getSheetByName(CONFIG.sheets.campingGroups);
  const assignmentsSheet    = ss.getSheetByName(CONFIG.sheets.assignments);
  const lodgingAssSheet     = ss.getSheetByName(CONFIG.sheets.lodgingAssignments);

  if (!regSheet) {
    SpreadsheetApp.getUi().alert('Registrations sheet not found.');
    return;
  }

  const lastRow = regSheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('No registrations found in the Registrations sheet.');
    return;
  }

  // ── Special-case entry IDs ──────────────────────────────────────────────
  // Test registrations by Caleb Durant — do not repair, mark as TEST.
  const TEST_ENTRIES      = ['3453', '3454'];
  // Duplicate submission (William Stout submitted twice).
  const DUPLICATE_ENTRIES = ['3503'];
  // Entries requiring a special note in the log.
  const SPECIAL_NOTES     = {
    '3490': 'Requires physical RV hookup setup at camp.'
  };

  // ── Read all Registrations rows into memory ────────────────────────────
  const numCols = regSheet.getLastColumn();
  const headers = regSheet.getRange(1, 1, 1, numCols).getValues()[0];
  const allRows = regSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  // ── Prepare the log sheet ──────────────────────────────────────────────
  const logSheet = getOrCreateLodgingRepairLogSheet_(ss);
  const logRows  = [];

  let fixedCount  = 0;
  let okCount     = 0;
  let reviewCount = 0;

  // ── Process each registration ──────────────────────────────────────────
  for (var i = 0; i < allRows.length; i++) {
    const rowNum = i + 2; // 1-based sheet row (row 1 = headers)

    // Build a keyed object from the raw row values
    const row = {};
    headers.forEach(function(h, j) {
      row[String(h || '').trim().toLowerCase()] = allRows[i][j];
    });

    const entryId        = String(row['fluent_form_entry_id'] || row['entry_id'] || '');
    const registrationId = String(row['registration_id'] || '');
    const registrantName = String(row['registrant_name'] || '');
    const email          = String(row['registrant_email'] || '');
    const storedLodging  = String(row['lodging_option_key'] || row['lodging_preference'] || '');

    // estimated_total is the pre-processing-fee base charge computed from the roster
    const registrationTotal = Number(row['estimated_total'] || row['frontend_total'] || 0);

    // ── Handle special cases first ──────────────────────────────────────
    if (TEST_ENTRIES.indexOf(entryId) >= 0) {
      logRows.push(buildLogRow_(entryId, registrantName, email, 0, 0,
        registrationTotal, 0, storedLodging, '', 'TEST', ''));
      reviewCount++;
      continue;
    }

    if (DUPLICATE_ENTRIES.indexOf(entryId) >= 0) {
      logRows.push(buildLogRow_(entryId, registrantName, email, 0, 0,
        registrationTotal, 0, storedLodging, '', 'DUPLICATE', ''));
      reviewCount++;
      continue;
    }

    // ── Parse roster JSON ───────────────────────────────────────────────
    var rosterPeople = [];
    try {
      const rJson = row['roster_json'];
      if (rJson) {
        const parsed = (typeof rJson === 'string') ? JSON.parse(rJson) : rJson;
        if (Array.isArray(parsed)) rosterPeople = parsed;
      }
    } catch (parseErr) {
      Logger.log('LodgingRepair: could not parse roster_json for entry ' + entryId + ': ' + parseErr);
    }

    const totalPeople = rosterPeople.length;

    // Count billed attendees (volunteers are free, so exclude them from the divisor)
    var billedCount = rosterPeople.filter(function(p) {
      return String(p.volunteer || p.is_volunteer || '').toLowerCase() !== 'yes';
    }).length;
    if (billedCount === 0) billedCount = totalPeople || 1;

    // ── Determine status ────────────────────────────────────────────────
    var status          = '';
    var correctedLodging = '';
    var perPersonPrice  = 0;

    if (registrationTotal <= 0) {
      // $0 registrations are volunteers or offline payments — cannot determine
      // lodging from price.
      status = 'NEEDS_MANUAL_REVIEW';
      reviewCount++;
    } else {
      perPersonPrice = registrationTotal / billedCount;
      const priceKey = lodgingKeyFromPerPersonPrice_(perPersonPrice);

      if (!priceKey) {
        // Per-person price doesn't match any known price within tolerance
        status = 'NEEDS_MANUAL_REVIEW';
        reviewCount++;
      } else if (storedLodging === priceKey) {
        status = 'OK';
        okCount++;
      } else if (storedLodging === 'shared_cabin_connected' && priceKey !== 'shared_cabin_connected') {
        // The most common bug: default of shared_cabin_connected was stored but
        // the price evidence points to a different option.
        status = 'AUTO-FIXABLE';
        correctedLodging = priceKey;
        // fixedCount is incremented below only if repair actually succeeds
      } else {
        // Stored lodging differs from price-derived but the stored value was NOT
        // shared_cabin_connected — requires human judgement.
        status = 'NEEDS_MANUAL_REVIEW';
        correctedLodging = priceKey; // record what price evidence suggests
        reviewCount++;
      }
    }

    const specialNote = SPECIAL_NOTES[entryId] || '';
    var repairedAt    = '';

    // ── Perform repair (non-dry-run AUTO-FIXABLE rows) ──────────────────
    if (!dryRun && status === 'AUTO-FIXABLE') {
      try {
        repairSingleRegistration_(
          ss, regSheet, rosterSheet, campingSheet, assignmentsSheet, lodgingAssSheet,
          rowNum, registrationId, correctedLodging
        );
        fixedCount++;
        status    = 'AUTO-FIXABLE (repaired)';
        repairedAt = new Date();
      } catch (repairErr) {
        Logger.log('LodgingRepair: repair failed for ' + registrationId + ': ' + repairErr);
        status = 'REPAIR_FAILED';
        reviewCount++;
      }
    } else if (status === 'AUTO-FIXABLE') {
      // Dry-run: count as "would fix"
      fixedCount++;
    }

    logRows.push(buildLogRow_(
      entryId, registrantName, email, totalPeople, billedCount,
      registrationTotal, perPersonPrice, storedLodging, correctedLodging,
      status + (specialNote ? ' — ' + specialNote : ''),
      repairedAt
    ));
  }

  // ── Write the repair log ───────────────────────────────────────────────
  writeRepairLogRows_(logSheet, logRows);

  // ── Refresh lodging inventory once (not per row) ───────────────────────
  if (!dryRun && fixedCount > 0) {
    try {
      refreshLodgingInventorySheet_(ss);
    } catch (refreshErr) {
      Logger.log('LodgingRepair: refreshLodgingInventorySheet_ failed after repair: ' + refreshErr);
    }
  }

  // ── Summary log ───────────────────────────────────────────────────────
  Logger.log(
    'Lodging repair complete: ' + fixedCount + ' fixed, ' +
    okCount + ' already OK, ' +
    reviewCount + ' need manual review'
  );

  SpreadsheetApp.getUi().alert(
    (dryRun ? '📋 Lodging Audit Complete (Preview Only)\n\n' : '✅ Lodging Repair Complete\n\n') +
    '✔ Already correct: '   + okCount    + '\n' +
    (dryRun ? '🔧 Would be repaired: ' : '🔧 Repaired: ') + fixedCount  + '\n' +
    '⚠️ Needs manual review: ' + reviewCount + '\n\n' +
    'See the LodgingRepairLog sheet for details.'
  );
}


// ============================================================
// SECTION 4 — SINGLE-ROW REPAIR HELPER
// ============================================================

/**
 * Updates all relevant sheets for a single registration to use
 * correctedLodging.
 *
 * Sheets updated:
 *   a/b. lodging_preference, lodging_option_key, lodging_option_label
 *        in Registrations
 *   c.   lodging_preference, lodging_option_key in Roster (all matching rows)
 *   d.   lodging_preference in CampingGroups and Assignments
 *   e.   lodging_preference, lodging_option_key in LodgingAssignments
 *
 * All writes use dynamic column mapping — no hardcoded column indexes.
 */
function repairSingleRegistration_(
  ss, regSheet, rosterSheet, campingSheet, assignmentsSheet, lodgingAssSheet,
  regRowNum, registrationId, correctedLodging
) {
  const correctedLabel = lodgingLabelFromKey_(correctedLodging);

  // ── a/b. Registrations sheet ──────────────────────────────────────────
  var col;
  col = getColumnNumber_(regSheet, 'lodging_preference');
  if (col > 0) regSheet.getRange(regRowNum, col).setValue(correctedLodging);

  col = getColumnNumber_(regSheet, 'lodging_option_key');
  if (col > 0) regSheet.getRange(regRowNum, col).setValue(correctedLodging);

  col = getColumnNumber_(regSheet, 'lodging_option_label');
  if (col > 0) regSheet.getRange(regRowNum, col).setValue(correctedLabel);

  // ── c. Roster sheet ───────────────────────────────────────────────────
  if (rosterSheet) {
    updateSheetRowsForRegistration_(
      rosterSheet, registrationId,
      { lodging_preference: correctedLodging, lodging_option_key: correctedLodging }
    );
  }

  // ── d. CampingGroups sheet ────────────────────────────────────────────
  if (campingSheet) {
    updateSheetRowsForRegistration_(
      campingSheet, registrationId,
      { lodging_preference: correctedLodging }
    );
  }

  // ── d. Assignments sheet ──────────────────────────────────────────────
  if (assignmentsSheet) {
    updateSheetRowsForRegistration_(
      assignmentsSheet, registrationId,
      { lodging_preference: correctedLodging }
    );
  }

  // ── e. LodgingAssignments sheet ───────────────────────────────────────
  if (lodgingAssSheet) {
    updateSheetRowsForRegistration_(
      lodgingAssSheet, registrationId,
      { lodging_preference: correctedLodging, lodging_option_key: correctedLodging }
    );
  }
}

/**
 * Sets specified column values on all rows in sheet where
 * registration_id matches.
 *
 * @param {Sheet}  sheet          — target sheet
 * @param {string} registrationId — value to match
 * @param {Object} updates        — { column_header: new_value, ... }
 */
function updateSheetRowsForRegistration_(sheet, registrationId, updates) {
  const sheetLastRow = sheet.getLastRow();
  if (sheetLastRow < 2) return;

  const regIdCol = getColumnNumber_(sheet, 'registration_id');
  if (regIdCol < 0) return;

  const regIds = sheet.getRange(2, regIdCol, sheetLastRow - 1, 1).getValues().flat();
  const updateKeys = Object.keys(updates);

  // Pre-resolve column numbers once
  const colNums = {};
  updateKeys.forEach(function(key) {
    colNums[key] = getColumnNumber_(sheet, key);
  });

  regIds.forEach(function(rid, idx) {
    if (String(rid) !== String(registrationId)) return;
    const rowNum = idx + 2;
    updateKeys.forEach(function(key) {
      const c = colNums[key];
      if (c > 0) sheet.getRange(rowNum, c).setValue(updates[key]);
    });
  });
}


// ============================================================
// SECTION 5 — LOG SHEET HELPERS
// ============================================================

/**
 * Gets (or creates and initialises) the LodgingRepairLog sheet.
 * Clears existing contents on each run so the log is always fresh.
 */
function getOrCreateLodgingRepairLogSheet_(ss) {
  const SHEET_NAME = 'LodgingRepairLog';
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  } else {
    sheet.clearContents();
    sheet.clearFormats();
  }

  const headers = [
    'entry_id', 'registrant_name', 'email',
    'people_count', 'billed_count',
    'registration_total', 'per_person_price',
    'stored_lodging', 'corrected_lodging',
    'status', 'repaired_at'
  ];
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange
    .setBackground(CONFIG.colors.headerBg)
    .setFontColor(CONFIG.colors.headerFg)
    .setFontWeight('bold');

  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * Builds a single log row array in the order expected by the header.
 */
function buildLogRow_(
  entryId, registrantName, email,
  totalPeople, billedCount, registrationTotal, perPersonPrice,
  storedLodging, correctedLodging, status, repairedAt
) {
  return [
    entryId, registrantName, email,
    totalPeople, billedCount,
    registrationTotal, perPersonPrice,
    storedLodging, correctedLodging,
    status, repairedAt
  ];
}

/**
 * Writes log rows to the sheet and applies colour-coding by status.
 *
 * Green  (#d4edda) — OK
 * Yellow (#fff3cd) — AUTO-FIXABLE / repaired
 * Red    (#f8d7da) — NEEDS_MANUAL_REVIEW, TEST, DUPLICATE, REPAIR_FAILED
 */
function writeRepairLogRows_(sheet, logRows) {
  if (!logRows || logRows.length === 0) return;

  const startRow  = 2;
  const numCols   = logRows[0].length;
  const statusIdx = 9; // 0-based index of the 'status' column

  sheet.getRange(startRow, 1, logRows.length, numCols).setValues(logRows);

  logRows.forEach(function(row, idx) {
    const rowNum = startRow + idx;
    const status = String(row[statusIdx] || '');
    var bg;
    if (status === 'OK') {
      bg = '#d4edda';                                   // green
    } else if (status.indexOf('AUTO-FIXABLE') >= 0) {
      bg = '#fff3cd';                                   // yellow
    } else if (
      status === 'NEEDS_MANUAL_REVIEW' ||
      status === 'TEST'                ||
      status === 'DUPLICATE'           ||
      status === 'REPAIR_FAILED'
    ) {
      bg = '#f8d7da';                                   // red
    }
    if (bg) {
      sheet.getRange(rowNum, 1, 1, numCols).setBackground(bg);
    }
  });
}

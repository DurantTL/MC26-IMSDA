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
  const keys = lodgingKeysFromPerPersonPrice_(perPersonPrice);
  return keys.length === 1 ? keys[0] : null;
}

/**
 * Returns all lodging keys whose configured price is within tolerance.
 *
 * @param {number} perPersonPrice
 * @param {number=} tolerance
 * @returns {Array<string>}
 */
function lodgingKeysFromPerPersonPrice_(perPersonPrice, tolerance) {
  const price = safeNumber_(perPersonPrice);
  if (price === null) return [];

  const diffTolerance = safeNumber_(tolerance);
  const delta = diffTolerance === null ? 0.50 : diffTolerance;

  const opts = CONFIG.registrationOptions || {};
  return Object.keys(opts).filter(function(key) {
    const configPrice = safeNumber_(opts[key] && opts[key].price);
    return configPrice !== null && Math.abs(configPrice - price) <= delta;
  });
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

/**
 * Authoritative historical repair mapping (per-person price => lodging key).
 */
function expectedLodgingFromPrice_(perPersonPrice) {
  const price = safeNumber_(perPersonPrice);
  if (price === null) return '';
  const rounded = Math.round(price * 100) / 100;
  const map = {
    120: 'shared_cabin_connected',
    100: 'shared_cabin_detached',
    90: 'rv_hookups',
    80: 'tent_no_hookups',
    70: 'sabbath_attendance_only'
  };
  return map[rounded] || '';
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
 * Repairs lodging for all AUTO_FIXABLE registrations based on
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
    'This will update lodging for all AUTO_FIXABLE registrations based on ' +
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
 * Decision design:
 * 1) Structural validity (is data present/parseable enough to reason about?)
 * 2) Price plausibility (does per-person heuristic produce a clear hint?)
 * 3) Repair eligibility (safe to write or requires human review?)
 *
 * IMPORTANT:
 * - Recognized lodging keys are not auto-trusted.
 * - Matching downstream tables are not treated as proof of correctness.
 * - Price inference is heuristic only; ambiguity routes to manual review.
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
  const TEST_ENTRIES      = { '3453': true, '3454': true };
  const DUPLICATE_ENTRIES = { '3503': true };
  const SPECIAL_NOTES     = {
    '3490': 'Requires physical RV hookup setup at camp.'
  };

  const numCols = regSheet.getLastColumn();
  const headers = regSheet.getRange(1, 1, 1, numCols).getValues()[0];
  const allRows = regSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  const logSheet = getOrCreateLodgingRepairLogSheet_(ss);
  const logRows  = [];

  let fixedCount  = 0;
  let okCount     = 0;
  let reviewCount = 0;

  for (var i = 0; i < allRows.length; i++) {
    const rowNum = i + 2;
    const row = rowObjectFromHeaders_(headers, allRows[i]);

    const entryId        = String(row['fluent_form_entry_id'] || row['entry_id'] || '').trim();
    const registrationId = String(row['registration_id'] || '').trim();
    const registrantName = String(row['registrant_name'] || '');
    const email          = String(row['registrant_email'] || '');
    const currentLodging = String(row['lodging_preference'] || row['lodging_option_key'] || '').trim();

    const structural = evaluateStructuralValidity_(row, entryId);
    const attendeeInfo = computeAttendeeCounts_(row, structural.rosterPeople);
    const registrationTotal = attendeeInfo.registrationTotal;

    const normalizedLodging = normalizeLodgingKeyForAudit_(currentLodging, {
      registrationTotal: registrationTotal,
      attendeeCount: attendeeInfo.billedCount
    });

    const pluginDeclared = extractPluginDeclaredLodgingForRepair_(row, structural.rosterPeople, attendeeInfo);
    const priceEval = evaluatePricePlausibility_(registrationTotal, attendeeInfo);

    const noteFlags = getSpecialNotesPresence_(row);

    const context = {
      dryRun: dryRun,
      row: row,
      noteFlags: noteFlags,
      rowNum: rowNum,
      entryId: entryId,
      registrationId: registrationId,
      currentLodging: currentLodging,
      normalizedLodging: normalizedLodging,
      pluginDeclared: pluginDeclared,
      structural: structural,
      attendeeInfo: attendeeInfo,
      priceEval: priceEval,
      specialNote: SPECIAL_NOTES[entryId] || '',
      isTest: !!TEST_ENTRIES[entryId],
      isDuplicate: !!DUPLICATE_ENTRIES[entryId]
    };

    const decision = classifyLodgingRepairDecision_(context);
    if (dryRun) decision.writeOccurred = false;

    if (!dryRun && decision.writeOccurred && decision.correctedLodging) {
      try {
        repairSingleRegistration_(
          ss, regSheet, rosterSheet, campingSheet, assignmentsSheet, lodgingAssSheet,
          rowNum, registrationId, decision.correctedLodging
        );
        fixedCount++;
      } catch (repairErr) {
        Logger.log('LodgingRepair: repair failed for ' + registrationId + ': ' + repairErr);
        decision.status = 'NEEDS_MANUAL_REVIEW';
        decision.reasonDetails = appendReason_(decision.reasonDetails, 'repair write failed: ' + repairErr);
        decision.writeOccurred = false;
      }
    }

    if (decision.status === 'OK') okCount++;
    if (decision.status !== 'OK' && decision.status !== 'AUTO_FIXABLE') reviewCount++;
    if (dryRun && decision.status === 'AUTO_FIXABLE') fixedCount++;

    logRows.push(buildLogRow_(
      entryId,
      registrantName,
      email,
      pluginDeclared,
      priceEval,
      normalizedLodging,
      registrationTotal,
      attendeeInfo.attendeeCountFromRow,
      decision
    ));
  }

  writeRepairLogRows_(logSheet, logRows);

  if (!dryRun && fixedCount > 0) {
    try {
      refreshLodgingInventorySheet_(ss);
    } catch (refreshErr) {
      Logger.log('LodgingRepair: refreshLodgingInventorySheet_ failed after repair: ' + refreshErr);
    }
  }

  Logger.log(
    'Lodging repair complete: ' + fixedCount + ' auto-fixable, ' +
    okCount + ' OK, ' +
    reviewCount + ' manual review'
  );

  SpreadsheetApp.getUi().alert(
    (dryRun ? '📋 Lodging Audit Complete (Preview Only)\n\n' : '✅ Lodging Repair Complete\n\n') +
    '✔ OK: ' + okCount + '\n' +
    (dryRun ? '🔧 AUTO_FIXABLE (would write): ' : '🔧 AUTO_FIXABLE (written): ') + fixedCount + '\n' +
    '⚠️ Needs manual review or inconsistent: ' + reviewCount + '\n\n' +
    'See the LodgingRepairLog sheet for details.'
  );
}


// ============================================================
// SECTION 4 — AUDIT DECISION HELPERS
// ============================================================

/**
 * Converts one sheet row to a normalized, lowercase-key object.
 */
function rowObjectFromHeaders_(headers, values) {
  const row = {};
  headers.forEach(function(h, j) {
    row[String(h || '').trim().toLowerCase()] = values[j];
  });
  return row;
}

/**
 * Safely parses a number. Returns null when value is not numeric.
 */
function safeNumber_(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  const cleaned = String(value).replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Parse roster JSON defensively.
 */
function parseRosterPeople_(row, entryId) {
  try {
    const rJson = row['roster_json'];
    if (!rJson) return [];
    const parsed = (typeof rJson === 'string') ? JSON.parse(rJson) : rJson;
    return Array.isArray(parsed) ? parsed : [];
  } catch (parseErr) {
    Logger.log('LodgingRepair: could not parse roster_json for entry ' + entryId + ': ' + parseErr);
    return [];
  }
}

function parseJsonObjectSafe_(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return null;
  }
}

function normalizeDeclaredLodgingKey_(value) {
  if (typeof canonicalizePluginLodgingKey_ === 'function') {
    return canonicalizePluginLodgingKey_(value);
  }
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const valid = (CONFIG.lodging && CONFIG.lodging.validation && CONFIG.lodging.validation.validPreferences) || [];
  if (valid.indexOf(raw) >= 0) return raw;
  if (raw === 'cabin_with_bath' || raw === 'shared cabin - connected restroom, linens provided') return 'shared_cabin_connected';
  if (raw === 'cabin_without_bath' || raw === 'shared cabin - detached restroom/shower, bring your own linens') return 'shared_cabin_detached';
  if (raw === 'rv') return 'rv_hookups';
  if (raw === 'tent') return 'tent_no_hookups';
  if (raw === 'sabbath_only' || raw === 'sabbath attendance only') return 'sabbath_attendance_only';
  return '';
}

function extractPluginDeclaredLodgingForRepair_(row, rosterPeople, attendeeInfo) {
  const payload = parseJsonObjectSafe_(row['payload_json']);
  const payloadType = normalizeDeclaredLodgingKey_(payload && payload.lodgingRequest && payload.lodgingRequest.type);
  if (payloadType) {
    return { lodging: payloadType, source: 'payload.lodgingRequest.type', consistent: true };
  }

  const lodgingReq = parseJsonObjectSafe_(row['lodging_request_json']);
  const requestJsonType = normalizeDeclaredLodgingKey_(lodgingReq && lodgingReq.type);
  if (requestJsonType) {
    return { lodging: requestJsonType, source: 'lodging_request_json.type', consistent: true };
  }

  const topLevel = normalizeDeclaredLodgingKey_(row['lodging_option_key']);
  if (topLevel) {
    return { lodging: topLevel, source: 'lodging_option_key', consistent: true };
  }

  const people = Array.isArray(rosterPeople) ? rosterPeople : [];
  const attendeeKeys = people.map(function(person) {
    return normalizeDeclaredLodgingKey_(person.lodging_option_key || person.lodgingOptionKey);
  }).filter(Boolean);
  const unique = attendeeKeys.filter(function(key, idx, arr) { return arr.indexOf(key) === idx; });
  if (unique.length === 1) {
    return { lodging: unique[0], source: 'people[].lodging_option_key', consistent: true };
  }
  if (unique.length > 1) {
    return { lodging: '', source: 'people[].lodging_option_key', consistent: false };
  }

  return { lodging: '', source: '', consistent: false };
}

/**
 * Structural validity only: parseability + minimum required identifiers.
 */
function evaluateStructuralValidity_(row, entryId) {
  const rosterPeople = parseRosterPeople_(row, entryId);
  const hasIdentifier = !!String(row['registration_id'] || row['fluent_form_entry_id'] || row['entry_id'] || '').trim();
  const hasAtLeastOneAttendee = rosterPeople.length > 0;
  return {
    rosterPeople: rosterPeople,
    hasIdentifier: hasIdentifier,
    rosterPresent: hasAtLeastOneAttendee,
    structurallyValid: hasIdentifier && hasAtLeastOneAttendee
  };
}

/**
 * Computes attendee counts and attendee-mix flags used by heuristic logic.
 */
function computeAttendeeCounts_(row, rosterPeople) {
  const people = Array.isArray(rosterPeople) ? rosterPeople : [];
  let volunteerCount = 0;
  let minorCount = 0;

  people.forEach(function(person) {
    const volunteerRaw = String(person.volunteer || person.is_volunteer || '').trim().toLowerCase();
    if (volunteerRaw === 'yes' || volunteerRaw === 'true' || volunteerRaw === '1') volunteerCount++;

    const ageGroup = String(person.age_group || person.ageGroup || '').trim().toLowerCase();
    const role = String(person.role || '').trim().toLowerCase();
    const age = safeNumber_(person.age);
    if (ageGroup === 'child' || ageGroup === 'minor' || role === 'child' || role === 'minor' || (age !== null && age < 18)) minorCount++;
  });

  const totalCount = people.length;
  const nonVolunteerCount = Math.max(totalCount - volunteerCount, 0);
  const billedCount = nonVolunteerCount > 0 ? nonVolunteerCount : (totalCount > 0 ? totalCount : 1);

  const regTotal = safeNumber_(row['registration_total']);
  const estimatedTotal = safeNumber_(row['estimated_total']);
  const frontendTotal = safeNumber_(row['frontend_total']);
  const registrationTotal = regTotal !== null
    ? regTotal
    : (estimatedTotal !== null ? estimatedTotal : (frontendTotal !== null ? frontendTotal : 0));

  const explicitAttendeeCount = safeNumber_(row['attendee_count']);

  return {
    totalCount: totalCount,
    volunteerCount: volunteerCount,
    minorCount: minorCount,
    billedCount: billedCount,
    registrationTotal: registrationTotal,
    attendeeCountFromRow: explicitAttendeeCount !== null ? explicitAttendeeCount : totalCount,
    hasGroupComplexity: totalCount > 1
  };
}

/**
 * Price plausibility using per-person heuristic only.
 */
function evaluatePricePlausibility_(registrationTotal, attendeeInfo) {
  const total = safeNumber_(registrationTotal);
  const attendeeCount = Math.max(safeNumber_(attendeeInfo.attendeeCountFromRow) || 0, 0);

  if (total === null || total <= 0 || attendeeCount < 1) {
    return {
      hasSignal: false,
      plausibility: 'unknown',
      perPersonAmount: '',
      candidateKeys: [],
      priceGuess: '',
      unambiguousGuess: '',
      explain: attendeeCount < 1
        ? 'missing/non-positive attendee count'
        : (total === 0 ? 'zero total' : 'missing/non-positive total')
    };
  }

  const perPerson = total / attendeeCount;
  const expectedLodging = expectedLodgingFromPrice_(perPerson);
  const candidateKeys = expectedLodging ? [expectedLodging] : [];
  const plausibility = expectedLodging ? 'affirmative' : 'inconsistent';

  return {
    hasSignal: true,
    plausibility: plausibility,
    perPersonAmount: perPerson,
    candidateKeys: candidateKeys,
    priceGuess: candidateKeys.join('|'),
    unambiguousGuess: expectedLodging,
    explain: plausibility === 'affirmative'
      ? 'single authoritative historical lodging match'
      : 'no authoritative historical lodging match'
  };
}

/**
 * Normalize current key defensively for audit comparisons.
 */
function normalizeLodgingKeyForAudit_(lodgingValue, context) {
  const raw = String(lodgingValue || '').trim();
  if (!raw) return '';

  if (typeof normalizeLodgingPreference_ === 'function') {
    return String(normalizeLodgingPreference_(raw, context) || '').trim();
  }
  return raw.toLowerCase();
}

/**
 * Return whether row has signals that make auto-repair unsafe.
 */
function getSpecialNotesPresence_(row) {
  const reasons = [];
  ['notes', 'special_notes', 'payment_notes', 'admin_notes'].forEach(function(key) {
    const text = String(row[key] || '').trim();
    if (text) reasons.push('note present in ' + key);
  });
  return reasons;
}

function hasRoommateComplexity_(row) {
  const fields = [
    'roommate_request', 'roommate_request_text', 'roommate_match_status',
    'matched_registration_id', 'matched_registrant_name', 'special_name2'
  ];
  return fields.some(function(key) {
    return String(row[key] || '').trim() !== '';
  });
}

function buildComplexityFlags_(ctx) {
  const flags = [];
  if (ctx.attendeeInfo.volunteerCount > 0) flags.push('volunteer');
  if (ctx.attendeeInfo.minorCount > 0) flags.push('minor');
  if (ctx.attendeeInfo.hasGroupComplexity) flags.push('group');
  if (hasRoommateComplexity_(ctx.row)) flags.push('roommate');
  if (ctx.noteFlags.length > 0) flags.push('special_notes');
  if (ctx.specialNote) flags.push('special_case_id');
  return flags;
}

function computeDecisionFlags_(ctx) {
  const complexityFlags = buildComplexityFlags_(ctx);
  const attendeeCount = safeNumber_(ctx.attendeeInfo.attendeeCountFromRow) || 0;
  const hasValidEntryId = String(ctx.entryId || '').trim() !== '';
  const simpleRowEligible = !ctx.isTest &&
    !ctx.isDuplicate &&
    hasValidEntryId &&
    attendeeCount >= 1 &&
    complexityFlags.length === 0;

  return {
    structuralValidityResult: !!ctx.structural.structurallyValid,
    pricePlausibilityResult: ctx.priceEval.plausibility || 'unknown',
    complexityFlags: complexityFlags,
    hasValidEntryId: hasValidEntryId,
    attendeeCount: attendeeCount,
    simpleRowEligible: simpleRowEligible,
    isSimpleRow: simpleRowEligible
  };
}

function classifyLodgingRepairDecision_(ctx) {
  const flags = computeDecisionFlags_(ctx);
  const pluginLodging = ctx.pluginDeclared.lodging || '';
  const priceLodging = ctx.priceEval.unambiguousGuess || '';
  const priceHasSignal = !!priceLodging;
  const currentStored = ctx.normalizedLodging || '';

  const reasonParts = [];
  if (!flags.structuralValidityResult) reasonParts.push('structural validity failed');
  if (!ctx.structural.hasIdentifier) reasonParts.push('missing registration/entry identifier');
  if (!ctx.structural.rosterPresent) reasonParts.push('roster missing or empty');
  if (ctx.specialNote) reasonParts.push(ctx.specialNote);
  if (ctx.noteFlags.length) reasonParts.push(ctx.noteFlags.join('|'));

  if (ctx.isTest) {
    return buildDecisionResult_('TEST', '', 'TEST_OVERRIDE', reasonParts, ['explicit test entry override'], false, 'blocked_special_case', flags, pluginLodging, priceLodging, currentStored);
  }
  if (ctx.isDuplicate) {
    return buildDecisionResult_('DUPLICATE', '', 'DUPLICATE_OVERRIDE', reasonParts, ['explicit duplicate entry override'], false, 'blocked_special_case', flags, pluginLodging, priceLodging, currentStored);
  }

  if (ctx.entryId === '3490') {
    return buildDecisionResult_(
      'NEEDS_MANUAL_REVIEW',
      '',
      'EXEMPT_3490_MANUAL_REVIEW',
      reasonParts,
      ['documented exemption 3490'],
      false,
      'documented_exemption',
      flags,
      pluginLodging,
      priceLodging,
      currentStored
    );
  }

  if (flags.simpleRowEligible) {
    if (!priceHasSignal) {
      return buildDecisionResult_(
        'NEEDS_MANUAL_REVIEW',
        '',
        'SIMPLE_NO_PRICE_MATCH',
        reasonParts,
        ['simple row requires authoritative price match'],
        false,
        'no_authoritative_price_mapping',
        flags,
        pluginLodging,
        priceLodging,
        currentStored
      );
    }
    if (currentStored !== priceLodging) {
      return buildDecisionResult_(
        'AUTO_FIXABLE',
        priceLodging,
        'SIMPLE_FIX_FROM_PRICE',
        reasonParts,
        ['historical repair uses authoritative price mapping'],
        true,
        '',
        flags,
        pluginLodging,
        priceLodging,
        currentStored
      );
    }
    return buildDecisionResult_(
      'OK',
      '',
      'SIMPLE_ALREADY_MATCHED_PRICE',
      reasonParts,
      ['stored lodging already matches authoritative price mapping'],
      false,
      '',
      flags,
      pluginLodging,
      priceLodging,
      currentStored
    );
  }

  return buildDecisionResult_(
    'NEEDS_MANUAL_REVIEW',
    '',
    'COMPLEX_MANUAL_REVIEW',
    reasonParts,
    ['complex row is not auto-fixable from price alone'],
    false,
    'complex_row',
    flags,
    pluginLodging,
    priceLodging,
    currentStored
  );
}

function buildDecisionResult_(status, correctedLodging, decisionBranch, reasonParts, extras, eligible, blockedBy, flags, pluginLodging, priceLodging, currentStored) {
  return {
    status: status,
    correctedLodging: correctedLodging,
    reasonDetails: buildReasonString_(appendReasonParts_(reasonParts, extras)),
    writeOccurred: eligible,
    decisionBranch: decisionBranch,
    conflictType: blockedBy || '',
    authoritativeLodgingDecision: correctedLodging || pluginLodging || priceLodging || currentStored || '',
    repairEligible: eligible,
    repairBlockedBy: blockedBy || '',
    debug: {
      structuralValidityResult: flags.structuralValidityResult,
      pricePlausibilityResult: flags.pricePlausibilityResult,
      complexityFlags: flags.complexityFlags,
      isSimpleRow: flags.isSimpleRow,
      simpleRowEligible: flags.simpleRowEligible,
      attendeeCount: flags.attendeeCount
    }
  };
}

function appendReasonParts_(baseParts, extraParts) {
  return (baseParts || []).concat(extraParts || []).filter(function(part) {
    return String(part || '').trim() !== '';
  });
}

function appendReason_(reasonDetails, extra) {
  return buildReasonString_(appendReasonParts_([reasonDetails], [extra]));
}

/**
 * Build compact reason text from an array.
 */
function buildReasonString_(parts) {
  const seen = {};
  const cleaned = (parts || []).map(function(p) {
    return String(p || '').trim();
  }).filter(function(p) {
    if (!p) return false;
    if (seen[p]) return false;
    seen[p] = true;
    return true;
  });
  return cleaned.join('; ');
}


// ============================================================
// SECTION 5 — SINGLE-ROW REPAIR HELPER
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

  var col;
  col = getColumnNumber_(regSheet, 'lodging_preference');
  if (col > 0) regSheet.getRange(regRowNum, col).setValue(correctedLodging);

  col = getColumnNumber_(regSheet, 'lodging_option_key');
  if (col > 0) regSheet.getRange(regRowNum, col).setValue(correctedLodging);

  col = getColumnNumber_(regSheet, 'lodging_option_label');
  if (col > 0) regSheet.getRange(regRowNum, col).setValue(correctedLabel);

  if (rosterSheet) {
    updateSheetRowsForRegistration_(
      rosterSheet, registrationId,
      { lodging_preference: correctedLodging, lodging_option_key: correctedLodging }
    );
  }

  if (campingSheet) {
    updateSheetRowsForRegistration_(
      campingSheet, registrationId,
      { lodging_preference: correctedLodging }
    );
  }

  if (assignmentsSheet) {
    updateSheetRowsForRegistration_(
      assignmentsSheet, registrationId,
      { lodging_preference: correctedLodging }
    );
  }

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
 */
function updateSheetRowsForRegistration_(sheet, registrationId, updates) {
  const sheetLastRow = sheet.getLastRow();
  if (sheetLastRow < 2) return;

  const regIdCol = getColumnNumber_(sheet, 'registration_id');
  if (regIdCol < 0) return;

  const regIds = sheet.getRange(2, regIdCol, sheetLastRow - 1, 1).getValues().flat();
  const updateKeys = Object.keys(updates);

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
// SECTION 6 — LOG SHEET HELPERS
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
    'entry_id',
    'registrant_name',
    'email',
    'pluginDeclaredLodging',
    'currentStoredLodging',
    'registrationTotal',
    'attendeeCount',
    'perPersonPrice',
    'expectedLodgingFromPrice',
    'simpleRowEligible',
    'repairEligible',
    'finalStatus',
    'repairReason',
    'writeOccurred',
    'decisionBranch',
    'pricePlausibilityResult',
    'complexityFlags',
    'conflictType',
    'authoritativeLodgingDecision',
    'repairBlockedBy'
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
  pluginDeclared, priceEval, currentStoredLodging,
  registrationTotal, attendeeCount, decision
) {
  const debug = decision.debug || {};
  return [
    entryId,
    registrantName,
    email,
    pluginDeclared.lodging || '',
    currentStoredLodging || '',
    registrationTotal,
    attendeeCount,
    priceEval.perPersonAmount,
    priceEval.unambiguousGuess || '',
    debug.simpleRowEligible ? 'TRUE' : 'FALSE',
    decision.repairEligible ? 'TRUE' : 'FALSE',
    decision.status,
    decision.reasonDetails,
    decision.writeOccurred ? 'YES' : 'NO',
    decision.decisionBranch || '',
    String(debug.pricePlausibilityResult || ''),
    (debug.complexityFlags || []).join('|'),
    decision.conflictType || '',
    decision.authoritativeLodgingDecision || '',
    decision.repairBlockedBy || ''
  ];
}

/**
 * Writes log rows to the sheet and applies colour-coding by status.
 */
function writeRepairLogRows_(sheet, logRows) {
  if (!logRows || logRows.length === 0) return;

  const startRow  = 2;
  const numCols   = logRows[0].length;
  const statusIdx = 11; // 0-based index of finalStatus

  sheet.getRange(startRow, 1, logRows.length, numCols).setValues(logRows);

  logRows.forEach(function(row, idx) {
    const rowNum = startRow + idx;
    const status = String(row[statusIdx] || '');
    var bg;

    if (status === 'OK') {
      bg = '#d4edda';
    } else if (status === 'AUTO_FIXABLE') {
      bg = '#fff3cd';
    } else if (
      status === 'NEEDS_MANUAL_REVIEW' ||
      status === 'TEST' ||
      status === 'DUPLICATE'
    ) {
      bg = '#f8d7da';
    }

    if (bg) {
      sheet.getRange(rowNum, 1, 1, numCols).setBackground(bg);
    }
  });
}

// ============================================================
// Man Camp Registration System
// Google Apps Script — Registration.gs
// Handles POST processing, cost calculations, and all sheet writes.
// ============================================================


// ============================================================
// SECTION 1 — CORE REGISTRATION PROCESSING
// ============================================================

/**
 * Main entry point for processing a registration payload.
 * Called by doPost() in Code.gs and also by resyncFromRawSheet().
 *
 * Flow:
 *   1. Normalize the incoming payload into a person-based submission model
 *   2. Duplicate guard by Fluent Forms entry ID
 *   3. Generate registration ID
 *   4. Build lodging summary placeholders
 *   5. Calculate cost breakdown
 *   6. Write to all four data sheets
 *   7. Mark RAW row processed
 *   8. Enqueue Email 1 + report-rebuild as background jobs
 *   9. Schedule a time-driven trigger to process those jobs
 *  10. Return success immediately
 *
 * Steps 8–9 replace the previous synchronous email send and report
 * regeneration. Offloading them allows doPost() to return a response
 * to Fluent Forms in well under the 6-minute execution limit, even
 * when many clubs register concurrently.
 *
 * @param  {Object} data — structured payload from WordPress plugin
 * @returns {Object}     { success, registrationId, emailQueued, attendeeCount }
 */
function processRegistration(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- 1. Normalize into the Phase 2 person-based model ---
  const normalized = normalizeRegistrationSubmission_(data);
  const roster = normalized.people;

  // --- 2. Duplicate guard (by Fluent Forms entry ID) ---
  if (normalized.fluentFormEntryId) {
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    if (regSheet && regSheet.getLastRow() > 1) {
      const entryIdColNum = getColumnNumber_(regSheet, 'fluent_form_entry_id');
      if (entryIdColNum > 0) {
        const lastRow         = regSheet.getLastRow();
        const existingEntries = regSheet
          .getRange(2, entryIdColNum, lastRow - 1, 1)
          .getValues().flat();
        if (existingEntries.includes(String(normalized.fluentFormEntryId))) {
          Logger.log('Duplicate submission detected for entry ' + normalized.fluentFormEntryId + ' — skipping.');
          return { success: false, duplicate: true, message: 'Duplicate submission — already processed.' };
        }
      }
    }
  }

  // --- 3. Generate registration ID ---
  const regSheet       = ss.getSheetByName(CONFIG.sheets.registrations);
  const registrationId = generateRegistrationId_(regSheet);
  const timestamp      = new Date();

  // --- 4. Enrich normalized data with generated IDs/timestamps ---
  normalized.registrationId = registrationId;
  normalized.timestamp      = timestamp;
  normalized.createdAt      = timestamp;
  normalized.roster         = roster;
  normalized.campingDetails = {
    lodging_preference: normalized.lodgingPreference,
    lodging_status:     normalized.lodgingStatus,
    assigned_lodging_area: normalized.assignedLodgingArea,
  };

  // --- 5. Apply deterministic lodging assignment rules before any writes ---
  const assigned = assignLodging(ss, normalized);
  assigned.campingDetails = {
    lodging_preference: assigned.lodgingPreference,
    lodging_status:     assigned.lodgingStatus,
    assigned_lodging_area: assigned.assignedLodgingArea,
  };

  // --- 6. Calculate cost ---
  assigned.costBreakdown = calculateCost_(assigned.roster, timestamp, Number(assigned.meal_count) || 0);

  // --- 7. Write to Registrations sheet ---
  writeRegistrationRow_(ss, assigned);

  // --- 8. Write attendees to Roster sheet ---
  writeRosterRows_(ss, assigned);

  // --- 9. Write lodging summary to legacy CampingGroups sheet ---
  processCampingGroup_(ss, assigned);

  // --- 10. Auto-populate Assignments sheet row ---
  writeAssignmentsRow_(ss, assigned);

  // --- 10.5 Persist per-person lodging assignments and refresh inventory summary ---
  persistLodgingAssignments_(ss, assigned);
  refreshLodgingInventorySheet_(ss);

  // --- 11. Mark RAW row as processed (if entry ID available) ---
  if (assigned.fluentFormEntryId) {
    markRawRowProcessed_(ss, assigned.fluentFormEntryId);
  }

  // --- 12. Enqueue Email 1 and report rebuild as background jobs ---
  // These are processed by processBackgroundJobs() via a time-driven
  // trigger, keeping this request well inside the 6-minute limit.
  if (CONFIG.email.enabled && assigned.registrantEmail) {
    enqueueBackgroundJob_({
      type:            'email',
      registrationId:  registrationId,
      registrantEmail: assigned.registrantEmail,
      clubName:        assigned.registrationLabel || assigned.clubName || ''
    });
  }
  enqueueBackgroundJob_({ type: 'report' });

  // --- 13. Ensure a background trigger is scheduled ---
  scheduleBackgroundTrigger_();

  Logger.log('Registration complete: ' + registrationId + ' (email & reports queued for background processing)');
  return {
    success:        true,
    registrationId: registrationId,
    emailSent:      false,   // kept for backward compatibility; email is queued
    emailQueued:    true,
    attendeeCount:  assigned.roster.length
  };
}


// ============================================================
// SECTION 2 — COST CALCULATION
// ============================================================

/**
 * Calculates the cost breakdown for a registration.
 *
 * Children are excluded from billing — adult attendees are counted toward
 * the base rate, late fee, and meal discount calculations.
 *
 * Base rate:  per billed person (pathfinder/tlt/staff)
 * Late fee:  + per billed person if submitted after April 10, 2026
 * Meal disc: − × meal_count  (meal_count = number of people being served)
 *
 * @param  {Array}  roster     — array of attendee objects
 * @param  {Date}   submitDate — submission timestamp
 * @param  {number} mealCount  — number of people the club will sponsor for a meal
 * @returns {Object} cost breakdown
 */
function calculateCost_(roster, submitDate, mealCount) {
  // Phase 2 person-based logic: bill adults, not children.
  const billedRoster   = roster.filter(p => {
    const ageGroup = String(p.ageGroup || p.age_group || '').toLowerCase();
    const role = String(p.role || '').toLowerCase();
    return ageGroup ? ageGroup !== 'child' : role !== 'child';
  });
  const totalAttendees = billedRoster.length;
  const baseAmount     = totalAttendees * CONFIG.pricing.baseRate;

  const isLate        = submitDate > CONFIG.pricing.earlyBirdDeadline;
  const lateFeeAmount = isLate ? totalAttendees * CONFIG.pricing.lateFee : 0;

  // Cap meal count at billed attendees to prevent an inflated discount.
  const safeMealCount  = Math.min(Math.max(0, mealCount || 0), totalAttendees);
  const mealDiscAmount = safeMealCount > 0
    ? safeMealCount * CONFIG.pricing.mealDiscount
    : 0;

  // Floor at zero so the estimated total can never go negative.
  const estimatedTotal = Math.max(0, baseAmount + lateFeeAmount - mealDiscAmount);

  return {
    totalAttendees:   totalAttendees,
    baseRate:         CONFIG.pricing.baseRate,
    baseAmount:       baseAmount,
    isLate:           isLate,
    lateFeePerPerson: isLate ? CONFIG.pricing.lateFee : 0,
    lateFeeAmount:    lateFeeAmount,
    mealCount:        safeMealCount,
    mealDiscAmount:   mealDiscAmount,
    estimatedTotal:   estimatedTotal
  };
}


// ============================================================
// SECTION 3 — SHEET WRITERS
// ============================================================

function writeRegistrationRow_(ss, data) {
  const sheet  = ss.getSheetByName(CONFIG.sheets.registrations);
  const roster = data.roster;
  const cost   = data.costBreakdown || {};
  const adultCount    = roster.filter(p => String(p.ageGroup || p.age_group).toLowerCase() === 'adult').length;
  const childCount    = roster.filter(p => String(p.ageGroup || p.age_group).toLowerCase() === 'child').length;
  const guardianCount = roster.filter(p => p.isGuardian).length;
  const primaryPerson = data.primaryPerson || roster[0] || {};

  // Legacy columns are still populated for compatibility with untouched admin/report paths.
  appendRowFromObject_(sheet, {
    timestamp:                data.timestamp,
    registration_id:          data.registrationId,
    registrant_name:          data.registrantName || '',
    registrant_email:         data.registrantEmail || '',
    registrant_phone:         data.registrantPhone || '',
    club_name:                data.registrationLabel || data.clubName || '',
    church_name:              data.church_name || '',
    total_pathfinders:        0,
    total_tlt:                0,
    total_staff:              adultCount,
    total_children:           childCount,
    total_attendees:          roster.length,
    duty_first:               '',
    duty_second:              '',
    flag_slots:               '',
    bathroom_days:            '',
    special_activity:         '',
    special_type:             '',
    special_type_church:      '',
    av_equipment:             '',
    campfire_night:           '',
    game_name:                '',
    game_action:              '',
    oregon_trail_adult:       '',
    special_name1:            '',
    meal_count:               Number(data.meal_count) || 0,
    meal_times:               normalizeArrayField_(data.meal_times),
    partner_club:             '',
    ribbons:                  '',
    baptism_names:            '',
    bible_names:              '',
    sabbath_skit:             '',
    estimated_total:          cost.estimatedTotal || 0,
    late_fee_applied:         cost.isLate ? 'Yes' : 'No',
    roster_json:              JSON.stringify(roster),
    fluent_form_entry_id:     String(data.fluentFormEntryId || ''),
    special_name2:            '',
    first_name:               primaryPerson.firstName || data.firstName || '',
    last_name:                primaryPerson.lastName || data.lastName || '',
    email:                    data.registrantEmail || '',
    phone:                    data.registrantPhone || '',
    age_group:                primaryPerson.ageGroup || '',
    is_guardian:              data.primaryPerson && data.primaryPerson.isGuardian ? 'Yes' : 'No',
    guardian_registration_id: data.primaryPerson && data.primaryPerson.guardianRegistrationId ? data.primaryPerson.guardianRegistrationId : '',
    guardian_link_key:        data.primaryPerson && data.primaryPerson.guardianLinkKey ? data.primaryPerson.guardianLinkKey : '',
    lodging_preference:       data.lodgingPreference || '',
    lodging_status:           data.lodgingStatus || 'pending',
    bunk_type:                data.bunkTypeSummary || 'none',
    assigned_lodging_area:    data.assignedLodgingArea || '',
    notes:                    data.notes || '',
    created_at:               data.createdAt || data.timestamp,
    registration_json:        JSON.stringify({
      registration_id: data.registrationId,
      registration_label: data.registrationLabel,
      adult_count: adultCount,
      child_count: childCount,
      guardian_count: guardianCount,
      lodging_preference: data.lodgingPreference,
      lodging_status: data.lodgingStatus,
      created_at: data.createdAt || data.timestamp
    })
  });
}

function writeRosterRows_(ss, data) {
  const sheet  = ss.getSheetByName(CONFIG.sheets.roster);
  const roster = data.roster;

  roster.forEach(person => {
    appendRowFromObject_(sheet, {
      registration_id:         data.registrationId,
      attendee_id:             person.id || '',
      attendee_name:           person.name || '',
      age:                     person.age || '',
      gender:                  person.gender || '',
      role:                    person.role || '',
      participation_status:    person.status || '',
      dietary_restrictions:    person.dietaryRestrictions || '',
      is_medical_personnel:    person.isMedicalPersonnel ? 'Yes' : 'No',
      is_master_guide_investiture: person.isMasterGuideInvestiture ? 'Yes' : 'No',
      is_first_time:           person.isFirstTime ? 'Yes' : 'No',
      counts_toward_billing:   String(person.ageGroup || '').toLowerCase() !== 'child' ? 'Yes' : 'No',
      club_name:               data.registrationLabel || data.clubName || '',
      registrant_email:        data.registrantEmail || '',
      timestamp:               data.timestamp,
      first_name:              person.firstName || '',
      last_name:               person.lastName || '',
      email:                   person.email || data.registrantEmail || '',
      phone:                   person.phone || data.registrantPhone || '',
      age_group:               person.ageGroup || '',
      is_guardian:             person.isGuardian ? 'Yes' : 'No',
      guardian_registration_id: person.guardianRegistrationId || '',
      guardian_link_key:       person.guardianLinkKey || '',
      lodging_preference:      person.lodgingPreference || data.lodgingPreference || '',
      lodging_status:          person.lodgingStatus || data.lodgingStatus || 'pending',
      bunk_type:               person.bunkType || 'none',
      assigned_lodging_area:   person.assignedLodgingArea || '',
      notes:                   person.notes || '',
      created_at:              person.createdAt || data.timestamp
    });
  });
}

function processCampingGroup_(ss, data) {
  const sheet   = ss.getSheetByName(CONFIG.sheets.campingGroups);
  const roster  = data.roster;
  const adultCount = roster.filter(p => String(p.ageGroup || '').toLowerCase() === 'adult').length;
  const childCount = roster.filter(p => String(p.ageGroup || '').toLowerCase() === 'child').length;
  const guardianCount = roster.filter(p => p.isGuardian).length;

  // Legacy sheet reused as a lodging summary table until a dedicated lodging sheet is introduced.
  appendRowFromObject_(sheet, {
    registration_id:       data.registrationId,
    club_name:             data.registrationLabel || data.clubName || '',
    tents:                 '',
    trailer:               '',
    kitchen_canopy:        '',
    total_sqft:            '',
    camp_next_to:          '',
    pathfinder_count:      0,
    tlt_count:             0,
    staff_count:           adultCount,
    child_count:           childCount,
    total_headcount:       roster.length,
    timestamp:             data.timestamp,
    lodging_preference:    data.lodgingPreference || '',
    lodging_status:        data.lodgingStatus || 'pending',
    bunk_type_summary:     data.bunkTypeSummary || 'none',
    assigned_lodging_area: data.assignedLodgingArea || '',
    notes:                 data.notes || '',
    adult_count:           adultCount,
    guardian_count:        guardianCount
  });
}

function writeAssignmentsRow_(ss, data) {
  const sheet = ss.getSheetByName(CONFIG.sheets.assignments);
  if (!sheet) return;

  appendRowFromObject_(sheet, {
    registration_id:       data.registrationId,
    club_name:             data.registrationLabel || data.clubName || '',
    director_email:        data.registrantEmail || '',
    duty_assigned:         '',
    duty_time_day:         '',
    special_activity_assigned: '',
    activity_detail:       '',
    camping_location:      data.assignedLodgingArea || '',
    camping_notes:         '',
    email_2_sent:          false,
    lodging_preference:    data.lodgingPreference || '',
    lodging_status:        data.lodgingStatus || 'pending',
    bunk_type_summary:     data.bunkTypeSummary || 'none',
    assigned_lodging_area: data.assignedLodgingArea || '',
    guardian_link_key:     data.guardianLinkSummary || '',
    notes:                 data.notes || '',
    created_at:            data.createdAt || data.timestamp
  });
}

function normalizeRegistrationSubmission_(data) {
  const peopleInput = parsePeopleInput_(data);
  if (!peopleInput || peopleInput.length === 0) {
    throw new Error('No participant records were provided — registration rejected.');
  }

  const primary = normalizePrimaryContact_(data, peopleInput);
  const registrationLabel = deriveRegistrationLabel_(primary, data);
  const lodgingPreference = normalizeLodgingPreference_(
    data.lodging_preference
      || (data.lodgingRequest && data.lodgingRequest.type)
      || data.lodgingPreference
      || ''
  );

  const createdAt = new Date();
  const people = peopleInput.map((person, index) =>
    normalizePersonRecord_(person, index, {
      primary,
      defaultEmail: primary.email,
      defaultPhone: primary.phone,
      lodgingPreference,
      createdAt
    })
  );

  const guardianLinks = people
    .filter(p => p.guardianLinkKey)
    .map(p => p.guardianLinkKey)
    .filter((key, idx, arr) => arr.indexOf(key) === idx);

  return {
    fluentFormEntryId: String(data.fluentFormEntryId || data.entry_id || '').trim(),
    firstName:         primary.firstName,
    lastName:          primary.lastName,
    registrantName:    primary.fullName,
    registrantEmail:   primary.email,
    registrantPhone:   primary.phone,
    church_name:       String(data.church_name || '').trim(),
    clubName:          registrationLabel,
    registrationLabel: registrationLabel,
    primaryPerson:     people[0] || null,
    people:            people,
    roster:            people,
    lodgingPreference: lodgingPreference,
    lodgingStatus:     deriveRegistrationLodgingStatus_(people),
    bunkTypeSummary:   deriveBunkTypeSummary_(people),
    assignedLodgingArea: String(data.assigned_lodging_area || data.cabin_assignment || '').trim(),
    guardianLinkSummary: guardianLinks.join(', '),
    notes:             String(data.notes || '').trim(),
    meal_count:        Number(data.meal_count) || 0,
    meal_times:        data.meal_times || [],
    primaryContact: {
      name:  primary.fullName,
      email: primary.email
    }
  };
}

function parsePeopleInput_(data) {
  const candidate = data.people !== undefined ? data.people : data.roster;
  if (candidate !== undefined) {
    try {
      const parsed = Array.isArray(candidate) ? candidate : JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      throw new Error('Invalid participant JSON: ' + err.toString());
    }
  }

  // Fallback: build a one-person registration from top-level fields.
  const firstName = String(data.first_name || data.firstName || '').trim();
  const lastName  = String(data.last_name || data.lastName || '').trim();
  const email     = String(data.email || data.registrantEmail || '').trim();
  const phone     = String(data.phone || data.registrantPhone || '').trim();
  if (firstName || lastName || email || phone) {
    return [{
      first_name: firstName,
      last_name:  lastName,
      email:      email,
      phone:      phone,
      age_group:  String(data.age_group || 'adult').trim().toLowerCase(),
      is_guardian: data.is_guardian !== undefined ? data.is_guardian : true,
      guardian_registration_id: data.guardian_registration_id || '',
      guardian_link_key: data.guardian_link_key || '',
      lodging_preference: data.lodging_preference || '',
      lodging_status: data.lodging_status || 'pending',
      bunk_type: data.bunk_type || 'none',
      assigned_lodging_area: data.assigned_lodging_area || data.cabin_assignment || '',
      notes: data.notes || ''
    }];
  }
  return [];
}

function normalizePrimaryContact_(data, peopleInput) {
  const firstPerson = peopleInput[0] || {};
  const explicitFirst = String(data.first_name || data.firstName || '').trim();
  const explicitLast  = String(data.last_name || data.lastName || '').trim();
  const fallbackName  = String(data.registrantName || firstPerson.name || '').trim();
  const split = splitName_(fallbackName);

  const firstName = explicitFirst || String(firstPerson.first_name || firstPerson.firstName || '').trim() || split.firstName;
  const lastName  = explicitLast  || String(firstPerson.last_name || firstPerson.lastName || '').trim() || split.lastName;
  const fullName  = [firstName, lastName].filter(Boolean).join(' ').trim() || fallbackName || 'Unknown Registrant';

  return {
    firstName: firstName,
    lastName:  lastName,
    fullName:  fullName,
    email:     String(data.email || data.registrantEmail || firstPerson.email || '').trim(),
    phone:     String(data.phone || data.registrantPhone || firstPerson.phone || '').trim()
  };
}

function normalizePersonRecord_(person, index, context) {
  const split = splitName_(String(person.name || '').trim());
  const firstName = String(person.first_name || person.firstName || split.firstName || '').trim();
  const lastName  = String(person.last_name || person.lastName || split.lastName || '').trim();
  const fullName  = [firstName, lastName].filter(Boolean).join(' ').trim() || String(person.name || '').trim() || ('Participant ' + (index + 1));

  const ageGroup = normalizeAgeGroup_(person);
  const isGuardian = toBoolean_(person.is_guardian !== undefined ? person.is_guardian : person.isGuardian)
    || (index === 0 && ageGroup === 'adult');

  const guardianRegistrationId = String(person.guardian_registration_id || person.guardianRegistrationId || '').trim();
  const guardianLinkKey = String(person.guardian_link_key || person.guardianLinkKey || '').trim();
  const lodgingPreference = normalizeLodgingPreference_(person.lodging_preference || person.lodgingPreference || context.lodgingPreference);
  const rawStatus = String(person.lodging_status || person.lodgingStatus || (ageGroup === 'child' && !isGuardian && !guardianRegistrationId && !guardianLinkKey ? 'manual_review' : 'pending')).trim().toLowerCase();
  const lodgingStatus = CONFIG.lodging.validation.validStatuses.includes(rawStatus) ? rawStatus : 'manual_review';

  // Business rule note: a child without a guardian link is flagged for manual review
  // rather than auto-assigned a bunk during Phase 2.
  const bunkType = normalizeBunkType_(
    person.bunk_type || person.bunkType || defaultBunkTypeForPreference_(lodgingPreference, lodgingStatus)
  );

  return {
    id:                       String(person.id || person.attendee_id || ('PERS-' + String(index + 1).padStart(3, '0'))).trim(),
    name:                     fullName,
    firstName:                firstName,
    lastName:                 lastName,
    email:                    String(person.email || context.defaultEmail || '').trim(),
    phone:                    String(person.phone || context.defaultPhone || '').trim(),
    age:                      person.age !== undefined && person.age !== null && person.age !== '' ? Number(person.age) : '',
    ageGroup:                 ageGroup,
    gender:                   String(person.gender || '').trim(),
    isGuardian:               isGuardian,
    guardianRegistrationId:   guardianRegistrationId,
    guardianLinkKey:          guardianLinkKey,
    lodgingPreference:        lodgingPreference,
    lodgingStatus:            lodgingStatus,
    bunkType:                 bunkType,
    assignedLodgingArea:      String(person.assigned_lodging_area || person.assignedLodgingArea || person.cabin_assignment || '').trim(),
    notes:                    String(person.notes || '').trim(),
    createdAt:                context.createdAt,
    // Legacy compatibility fields used by untouched admin/email/report code.
    role:                     ageGroup === 'child' ? 'child' : 'staff',
    status:                   String(person.status || 'pending').trim().toLowerCase(),
    dietaryRestrictions:      String(person.dietaryRestrictions || person.dietary_restrictions || '').trim(),
    isMedicalPersonnel:       toBoolean_(person.isMedicalPersonnel),
    isMasterGuideInvestiture: toBoolean_(person.isMasterGuideInvestiture),
    isFirstTime:              toBoolean_(person.isFirstTime)
  };
}

function normalizeAgeGroup_(person) {
  const explicit = String(person.age_group || person.ageGroup || '').trim().toLowerCase();
  if (explicit === 'adult' || explicit === 'child') return explicit;

  const role = String(person.role || '').trim().toLowerCase();
  if (role === 'child') return 'child';

  const age = Number(person.age);
  return !isNaN(age) && age < 18 ? 'child' : 'adult';
}

function normalizeLodgingPreference_(value) {
  const raw = String(value || '').trim().toLowerCase();
  const valid = CONFIG.lodging.validation.validPreferences;
  if (valid.includes(raw)) return raw;
  if (raw === 'cabin_with_bath') return 'cabin_bath';
  if (raw === 'cabin_without_bath') return 'cabin_no_bath';
  return raw || 'tent';
}

function normalizeBunkType_(value) {
  const raw = String(value || '').trim().toLowerCase();
  const valid = CONFIG.lodging.validation.validBunkTypes;
  return valid.includes(raw) ? raw : 'none';
}

function defaultBunkTypeForPreference_(lodgingPreference, lodgingStatus) {
  if (lodgingStatus === 'manual_review' || lodgingStatus === 'waitlist') return 'none';
  if (lodgingPreference === 'rv') return 'rv';
  if (lodgingPreference === 'tent') return 'tent';
  return 'none';
}

function deriveRegistrationLodgingStatus_(people) {
  if (people.some(p => p.lodgingStatus === 'manual_review')) return 'manual_review';
  if (people.some(p => p.lodgingStatus === 'waitlist')) return 'waitlist';
  if (people.some(p => p.lodgingStatus === 'assigned')) return 'assigned';
  return 'pending';
}

function deriveBunkTypeSummary_(people) {
  const types = people.map(p => p.bunkType).filter(Boolean);
  return types.filter((type, idx, arr) => arr.indexOf(type) === idx).join(', ') || 'none';
}

function deriveRegistrationLabel_(primary, data) {
  const explicit = String(data.registration_label || data.registrationLabel || '').trim();
  if (explicit) return explicit;
  if (primary.lastName) return primary.lastName + ' Household';
  return primary.fullName || 'Registration';
}

function splitName_(fullName) {
  const cleaned = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(' ');
  return {
    firstName: parts[0] || '',
    lastName:  parts.length > 1 ? parts.slice(1).join(' ') : ''
  };
}

function toBoolean_(value) {
  if (typeof value === 'boolean') return value;
  const raw = String(value || '').trim().toLowerCase();
  return ['true', 'yes', '1', 'on'].includes(raw);
}

/**
 * Sets the 'processed' column on the matching RAW sheet row to TRUE.
 *
 * @param {Spreadsheet} ss
 * @param {string|number} entryId — Fluent Forms entry ID
 */
function markRawRowProcessed_(ss, entryId) {
  const sheet = ss.getSheetByName(CONFIG.sheets.raw);
  if (!sheet) return;

  // Use dynamic column mapping so column order changes don't break this
  const entryIdColNum   = getColumnNumber_(sheet, 'entry_id');
  const processedColNum = getColumnNumber_(sheet, 'processed');
  if (entryIdColNum < 0 || processedColNum < 0) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const entryIds = sheet.getRange(2, entryIdColNum, lastRow - 1, 1).getValues().flat();
  const rowIndex = entryIds.indexOf(String(entryId));
  if (rowIndex >= 0) {
    sheet.getRange(rowIndex + 2, processedColNum).setValue('TRUE');
  }
}

/**
 * Appends a row to the EmailLog sheet.
 *
 * @param {Spreadsheet} ss
 * @param {string} registrationId
 * @param {string} email
 * @param {string} clubName
 * @param {string} status         — e.g. 'email1_sent', 'email1_failed', 'email1_resent'
 * @param {string} errorMsg       — empty string on success
 */
function logEmail_(ss, registrationId, email, clubName, status, errorMsg) {
  const sheet = ss.getSheetByName(CONFIG.sheets.emailLog);
  if (!sheet) return;
  sheet.appendRow([
    new Date(),
    registrationId,
    email,
    clubName,
    status,
    errorMsg
  ]);
}

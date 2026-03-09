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

  // --- 5. Validate age/program/guardian/inventory rules before any writes ---
  const validation = validateRegistrationSubmission_(ss, normalized);
  if (!validation.success) {
    return validation;
  }

  // --- 6. Apply deterministic lodging assignment rules before any writes ---
  const assigned = assignLodging(ss, normalized);
  applyValidationFlagsToAssignedRegistration_(assigned, validation);
  assigned.campingDetails = {
    lodging_preference: assigned.lodgingPreference,
    lodging_status:     assigned.lodgingStatus,
    assigned_lodging_area: assigned.assignedLodgingArea,
  };

  // --- 7. Preserve selected option and paid totals for Square reconciliation ---
  assigned.costBreakdown = calculateCost_(assigned, timestamp);

  // --- 8. Write to Registrations sheet ---
  writeRegistrationRow_(ss, assigned);

  // --- 9. Write attendees to Roster sheet ---
  writeRosterRows_(ss, assigned);

  // --- 10. Write lodging summary to legacy CampingGroups sheet ---
  processCampingGroup_(ss, assigned);

  // --- 11. Auto-populate Assignments sheet row ---
  writeAssignmentsRow_(ss, assigned);

  // --- 11.5 Persist per-person lodging assignments and refresh inventory summary ---
  persistLodgingAssignments_(ss, assigned);
  refreshLodgingInventorySheet_(ss);
  refreshShirtInventorySheet_(ss);

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
function calculateCost_(registrationData) {
  const option = getRegistrationOptionByKey_(registrationData.lodgingOptionKey || registrationData.lodgingPreference || '');
  const configuredPrice = option ? Number(option.price) || 0 : 0;
  const selectedPrice = registrationData.priceSelected !== '' && registrationData.priceSelected !== undefined
    ? Number(registrationData.priceSelected) || 0
    : configuredPrice;
  const squareTotal = registrationData.squareTotal !== '' && registrationData.squareTotal !== undefined
    ? Number(registrationData.squareTotal) || 0
    : '';
  const frontendTotal = registrationData.frontendTotal !== '' && registrationData.frontendTotal !== undefined
    ? Number(registrationData.frontendTotal) || 0
    : '';
  const amountPaid = registrationData.amountPaid !== '' && registrationData.amountPaid !== undefined
    ? Number(registrationData.amountPaid) || 0
    : (squareTotal !== '' ? squareTotal : (frontendTotal !== '' ? frontendTotal : selectedPrice));

  return {
    configuredPrice: configuredPrice,
    selectedPrice: selectedPrice,
    frontendTotal: frontendTotal,
    squareTotal: squareTotal,
    amountPaid: amountPaid,
    estimatedTotal: amountPaid || selectedPrice,
    paymentStatus: String(registrationData.paymentStatus || '').trim().toLowerCase() || 'pending'
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
    late_fee_applied:         'No',
    roster_json:              JSON.stringify(roster),
    fluent_form_entry_id:     String(data.fluentFormEntryId || ''),
    special_name2:            '',
    first_name:               primaryPerson.firstName || data.firstName || '',
    last_name:                primaryPerson.lastName || data.lastName || '',
    email:                    data.registrantEmail || '',
    phone:                    data.registrantPhone || '',
    age:                      primaryPerson.age || data.age || '',
    age_group:                primaryPerson.ageGroup || '',
    is_minor:                 primaryPerson.isMinor ? 'Yes' : 'No',
    is_guardian:              data.primaryPerson && data.primaryPerson.isGuardian ? 'Yes' : 'No',
    guardian_name:            data.guardianName || primaryPerson.guardianName || '',
    guardian_phone:           data.guardianPhone || primaryPerson.guardianPhone || '',
    guardian_email:           data.guardianEmail || primaryPerson.guardianEmail || '',
    guardian_relationship:    data.guardianRelationship || primaryPerson.guardianRelationship || '',
    guardian_registration_id: data.primaryPerson && data.primaryPerson.guardianRegistrationId ? data.primaryPerson.guardianRegistrationId : '',
    guardian_link_key:        data.primaryPerson && data.primaryPerson.guardianLinkKey ? data.primaryPerson.guardianLinkKey : '',
    lodging_preference:       data.lodgingPreference || '',
    lodging_option_key:       data.lodgingOptionKey || '',
    lodging_option_label:     data.lodgingOptionLabel || '',
    attendance_type:          data.attendanceType || '',
    program_type:             data.programType || '',
    shirt_size:               data.shirtSize || '',
    price_selected:           data.priceSelected !== '' ? data.priceSelected : (cost.selectedPrice || 0),
    option_price:             cost.configuredPrice || 0,
    payment_status:           data.paymentStatus || cost.paymentStatus || '',
    payment_reference:        data.paymentReference || '',
    payment_method:           data.paymentMethod || CONFIG.payments.defaultMethod,
    frontend_total:           cost.frontendTotal === '' ? '' : cost.frontendTotal,
    square_total:             cost.squareTotal === '' ? '' : cost.squareTotal,
    amount_paid:              cost.amountPaid || 0,
    medical_notes:            data.medicalNotes || '',
    special_considerations:   data.specialConsiderations || '',
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
      age:                     person.age || '',
      age_group:               person.ageGroup || '',
      is_minor:                person.isMinor ? 'Yes' : 'No',
      is_guardian:             person.isGuardian ? 'Yes' : 'No',
      guardian_name:           person.guardianName || '',
      guardian_phone:          person.guardianPhone || '',
      guardian_email:          person.guardianEmail || '',
      guardian_relationship:   person.guardianRelationship || '',
      guardian_registration_id: person.guardianRegistrationId || '',
      guardian_link_key:       person.guardianLinkKey || '',
      lodging_preference:      person.lodgingPreference || data.lodgingPreference || '',
      lodging_option_key:      person.lodgingOptionKey || data.lodgingOptionKey || '',
      lodging_option_label:    person.lodgingOptionLabel || data.lodgingOptionLabel || '',
      attendance_type:         person.attendanceType || data.attendanceType || '',
      program_type:            person.programType || data.programType || '',
      shirt_size:              person.shirtSize || '',
      price_selected:          data.priceSelected !== '' ? data.priceSelected : '',
      payment_status:          data.paymentStatus || '',
      payment_reference:       data.paymentReference || '',
      medical_notes:           person.medicalNotes || '',
      special_considerations:  person.specialConsiderations || '',
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
  const minorCount = roster.filter(p => p.isMinor).length;
  const shirtCounts = summarizeCountsByField_(roster, 'shirtSize');
  const programCounts = summarizeCountsByField_(roster, 'programType');

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
    guardian_count:        guardianCount,
    minor_count:           minorCount,
    program_counts:        JSON.stringify(programCounts),
    shirt_counts:          JSON.stringify(shirtCounts)
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
    created_at:            data.createdAt || data.timestamp,
    payment_status:        data.paymentStatus || '',
    payment_reference:     data.paymentReference || '',
    program_counts:        JSON.stringify(summarizeCountsByField_(data.roster || [], 'programType'))
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
    data.lodging_option_key
      || data.lodging_preference
      || (data.lodgingRequest && data.lodgingRequest.type)
      || data.lodgingPreference
      || ''
  );
  const option = getRegistrationOptionByKey_(lodgingPreference);
  const programType = normalizeProgramType_(data.program_type || data.programType || '');

  const createdAt = new Date();
  const people = peopleInput.map((person, index) =>
    normalizePersonRecord_(person, index, {
      primary,
      defaultEmail: primary.email,
      defaultPhone: primary.phone,
      lodgingPreference,
      lodgingOptionKey: lodgingPreference,
      lodgingOptionLabel: option ? option.label : String(data.lodging_option_label || ''),
      attendanceType: option ? option.attendanceType : String(data.attendance_type || ''),
      programType: programType,
      shirtSize: normalizeShirtSize_(data.shirt_size || ''),
      guardianName: String(data.guardian_name || '').trim(),
      guardianPhone: String(data.guardian_phone || '').trim(),
      guardianEmail: String(data.guardian_email || '').trim(),
      guardianRelationship: String(data.guardian_relationship || '').trim(),
      medicalNotes: String(data.medical_notes || data.medical || '').trim(),
      specialConsiderations: String(data.special_considerations || '').trim(),
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
    age:               people[0] ? people[0].age : '',
    ageGroup:          people[0] ? people[0].ageGroup : '',
    isMinor:           people[0] ? people[0].isMinor : false,
    guardianName:      String(data.guardian_name || (people[0] ? people[0].guardianName : '') || '').trim(),
    guardianPhone:     String(data.guardian_phone || (people[0] ? people[0].guardianPhone : '') || '').trim(),
    guardianEmail:     String(data.guardian_email || (people[0] ? people[0].guardianEmail : '') || '').trim(),
    guardianRelationship: String(data.guardian_relationship || (people[0] ? people[0].guardianRelationship : '') || '').trim(),
    lodgingPreference: lodgingPreference,
    lodgingOptionKey:  lodgingPreference,
    lodgingOptionLabel: option ? option.label : String(data.lodging_option_label || '').trim(),
    attendanceType:    option ? option.attendanceType : String(data.attendance_type || '').trim(),
    programType:       programType,
    shirtSize:         normalizeShirtSize_(data.shirt_size || (people[0] ? people[0].shirtSize : '')),
    priceSelected:     data.price_selected !== undefined && data.price_selected !== '' ? Number(data.price_selected) || 0 : (option ? option.price : ''),
    paymentStatus:     normalizePaymentStatus_(data.payment_status || data.paymentStatus || ''),
    paymentReference:  String(data.payment_reference || data.transaction_id || data.transactionId || data.order_id || '').trim(),
    paymentMethod:     String(data.payment_method || data.paymentMethod || CONFIG.payments.defaultMethod).trim(),
    frontendTotal:     data.frontend_total !== undefined && data.frontend_total !== '' ? Number(data.frontend_total) || 0 : '',
    squareTotal:       data.square_total !== undefined && data.square_total !== '' ? Number(data.square_total) || 0 : '',
    amountPaid:        data.amount_paid !== undefined && data.amount_paid !== '' ? Number(data.amount_paid) || 0 : '',
    medicalNotes:      String(data.medical_notes || data.medical || '').trim(),
    specialConsiderations: String(data.special_considerations || '').trim(),
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
      age:        data.age || '',
      is_minor:   data.is_minor || '',
      is_guardian: data.is_guardian !== undefined ? data.is_guardian : true,
      guardian_name: data.guardian_name || '',
      guardian_phone: data.guardian_phone || '',
      guardian_email: data.guardian_email || '',
      guardian_relationship: data.guardian_relationship || '',
      guardian_registration_id: data.guardian_registration_id || '',
      guardian_link_key: data.guardian_link_key || '',
      lodging_preference: data.lodging_option_key || data.lodging_preference || '',
      lodging_option_key: data.lodging_option_key || data.lodging_preference || '',
      lodging_option_label: data.lodging_option_label || '',
      attendance_type: data.attendance_type || '',
      program_type: data.program_type || '',
      shirt_size: data.shirt_size || '',
      price_selected: data.price_selected || '',
      payment_status: data.payment_status || '',
      payment_reference: data.payment_reference || data.transaction_id || '',
      medical_notes: data.medical_notes || '',
      special_considerations: data.special_considerations || '',
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

  const age = person.age !== undefined && person.age !== null && person.age !== '' ? Number(person.age) : '';
  const ageGroup = normalizeAgeGroup_(person);
  const isMinor = age !== '' ? age < CONFIG.ageRules.adultMinAge : ageGroup === 'child';
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
    age:                      age,
    ageGroup:                 ageGroup,
    isMinor:                  isMinor,
    gender:                   String(person.gender || '').trim(),
    isGuardian:               isGuardian,
    guardianName:             String(person.guardian_name || person.guardianName || context.guardianName || '').trim(),
    guardianPhone:            String(person.guardian_phone || person.guardianPhone || context.guardianPhone || '').trim(),
    guardianEmail:            String(person.guardian_email || person.guardianEmail || context.guardianEmail || '').trim(),
    guardianRelationship:     String(person.guardian_relationship || person.guardianRelationship || context.guardianRelationship || '').trim(),
    guardianRegistrationId:   guardianRegistrationId,
    guardianLinkKey:          guardianLinkKey,
    lodgingPreference:        lodgingPreference,
    lodgingOptionKey:         String(person.lodging_option_key || person.lodgingOptionKey || context.lodgingOptionKey || lodgingPreference).trim(),
    lodgingOptionLabel:       String(person.lodging_option_label || person.lodgingOptionLabel || context.lodgingOptionLabel || '').trim(),
    attendanceType:           String(person.attendance_type || person.attendanceType || context.attendanceType || '').trim(),
    programType:              normalizeProgramType_(person.program_type || person.programType || context.programType || ''),
    shirtSize:                normalizeShirtSize_(person.shirt_size || person.shirtSize || context.shirtSize || ''),
    lodgingStatus:            lodgingStatus,
    bunkType:                 bunkType,
    assignedLodgingArea:      String(person.assigned_lodging_area || person.assignedLodgingArea || person.cabin_assignment || '').trim(),
    notes:                    String(person.notes || '').trim(),
    medicalNotes:             String(person.medical_notes || person.medicalNotes || context.medicalNotes || '').trim(),
    specialConsiderations:    String(person.special_considerations || person.specialConsiderations || context.specialConsiderations || '').trim(),
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
  return !isNaN(age) && age < CONFIG.ageRules.adultMinAge ? 'child' : 'adult';
}

function normalizeLodgingPreference_(value) {
  const raw = String(value || '').trim().toLowerCase();
  const valid = CONFIG.lodging.validation.validPreferences;
  if (valid.includes(raw)) return raw;
  if (raw === 'cabin_with_bath' || raw === 'shared cabin - connected restroom, linens provided') return 'shared_cabin_connected';
  if (raw === 'cabin_without_bath' || raw === 'shared cabin - detached restroom/shower, bring your own linens') return 'shared_cabin_detached';
  if (raw === 'rv') return 'rv_hookups';
  if (raw === 'tent') return 'tent_no_hookups';
  if (raw === 'sabbath_only' || raw === 'sabbath attendance only') return 'sabbath_attendance_only';
  return raw || 'tent_no_hookups';
}

function normalizeBunkType_(value) {
  const raw = String(value || '').trim().toLowerCase();
  const valid = CONFIG.lodging.validation.validBunkTypes;
  return valid.includes(raw) ? raw : 'none';
}

function defaultBunkTypeForPreference_(lodgingPreference, lodgingStatus) {
  if (lodgingStatus === 'manual_review' || lodgingStatus === 'waitlist') return 'none';
  if (lodgingPreference === 'rv_hookups') return 'rv';
  if (lodgingPreference === 'tent_no_hookups') return 'tent';
  if (lodgingPreference === 'sabbath_attendance_only') return 'day_only';
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

function normalizeProgramType_(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === CONFIG.programs.youngMens.key) return CONFIG.programs.youngMens.key;
  return CONFIG.programs.standard.key;
}

function normalizeShirtSize_(value) {
  const raw = String(value || '').trim().toUpperCase();
  return CONFIG.shirts.sizes[raw] !== undefined ? raw : raw;
}

function normalizePaymentStatus_(value) {
  const raw = String(value || '').trim().toLowerCase();
  return CONFIG.payments.acceptedStatuses.includes(raw) ? raw : 'pending';
}

function summarizeCountsByField_(rows, fieldName) {
  return (rows || []).reduce((acc, row) => {
    const key = String(row[fieldName] || '').trim();
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function validateRegistrationSubmission_(ss, normalized) {
  const errors = [];
  const flags = {
    forceManualReview: false,
    manualReviewReasons: [],
    inventoryMessages: []
  };
  const primary = normalized.primaryPerson || {};
  const option = getRegistrationOptionByKey_(normalized.lodgingOptionKey || normalized.lodgingPreference || '');

  if (!normalized.firstName || !normalized.lastName) errors.push('Registrant first and last name are required.');
  if (!normalized.registrantEmail) errors.push('Registrant email is required.');
  if (primary.age === '' || isNaN(Number(primary.age))) errors.push('Registrant age is required.');
  if (!option) errors.push('A valid registration option is required.');
  if (!normalized.shirtSize) errors.push('Shirt size is required.');

  const primaryIsMinor = !!primary.isMinor;
  if (primaryIsMinor) {
    if (!normalized.guardianName || !normalized.guardianPhone || !normalized.guardianEmail || !normalized.guardianRelationship) {
      flags.forceManualReview = true;
      flags.manualReviewReasons.push('Minor is missing guardian name, phone, email, or relationship.');
    }
  }

  if (normalized.programType === CONFIG.programs.youngMens.key) {
    const age = Number(primary.age);
    if (isNaN(age) || age < CONFIG.programs.youngMens.minAge || age > CONFIG.programs.youngMens.maxAge) {
      errors.push("Young Men's program is only available for ages 10-14.");
    }
    if (!primaryIsMinor) {
      errors.push("Young Men's program registrants must be minors with guardian information on file.");
    }
  }

  const inventory = checkInventoryAvailability_(ss, normalized);
  if (!inventory.valid) {
    inventory.messages.forEach(message => {
      if (message.indexOf('Shirt size') === 0) {
        flags.forceManualReview = true;
        flags.manualReviewReasons.push(message);
      } else {
        flags.inventoryMessages.push(message);
      }
    });
  }

  if (errors.length) {
    return {
      success: false,
      message: errors.join(' '),
      errors: errors,
      manualReview: flags.forceManualReview,
      waitlistAvailable: flags.inventoryMessages.some(err => err.indexOf('sold out') >= 0)
    };
  }

  return {
    success: true,
    flags: flags
  };
}

function applyValidationFlagsToAssignedRegistration_(assigned, validation) {
  const flags = validation && validation.flags ? validation.flags : null;
  if (!flags) return;

  if (flags.forceManualReview) {
    (assigned.people || []).forEach(person => {
      person.lodgingStatus = 'manual_review';
      person.bunkType = 'none';
      person.assignmentReason = [person.assignmentReason].concat(flags.manualReviewReasons).filter(Boolean).join(' ');
      person.consumesPublicInventory = false;
    });
    assigned.lodgingStatus = 'manual_review';
    assigned.bunkTypeSummary = 'none';
  }
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

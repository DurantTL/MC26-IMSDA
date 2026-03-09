// ============================================================
// Man Camp Registration System
// Google Apps Script — Reports.gs
// Lodging-first operational reports for Man Camp.
// ============================================================


// ============================================================
// SECTION 1 — DATA ACCESS
// ============================================================

function getRegistrationReportData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  const lodgingSheet = ss.getSheetByName(CONFIG.sheets.lodgingAssignments);
  const inventorySheet = ss.getSheetByName(CONFIG.sheets.lodgingInventory);

  const registrations = readSheetObjects_(regSheet);
  const rosterRows = readSheetObjects_(rosterSheet);
  const lodgingRows = readSheetObjects_(lodgingSheet);
  const inventoryRows = readSheetObjects_(inventorySheet);

  const peopleByRegistration = groupRowsBy_(rosterRows, 'registration_id');
  const lodgingByRegistration = groupRowsBy_(lodgingRows, 'registration_id');

  const normalized = registrations.map((reg) => {
    const registrationId = String(reg.registration_id || '').trim();
    const people = peopleByRegistration.get(registrationId) || [];
    const lodgingAssignments = lodgingByRegistration.get(registrationId) || [];
    const primary = people[0] || {};
    const registrationLabel = String(
      reg.registration_label ||
      reg.club_name ||
      [reg.first_name, reg.last_name].filter(Boolean).join(' ').trim() ||
      reg.registrant_name ||
      registrationId ||
      'Registration'
    ).trim();

    const guardianPairs = buildGuardianChildPairs_(people);
    const flags = collectRegistrationFlags_(people);

    return {
      registrationId,
      registrationLabel,
      timestamp: reg.timestamp || '',
      registrantName: String(reg.registrant_name || [reg.first_name, reg.last_name].filter(Boolean).join(' ').trim() || primary.attendee_name || '').trim(),
      registrantEmail: String(reg.registrant_email || reg.email || primary.email || '').trim(),
      registrantPhone: String(reg.registrant_phone || reg.phone || primary.phone || '').trim(),
      lodgingPreference: String(reg.lodging_preference || primary.lodging_preference || '').trim(),
      lodgingStatus: String(reg.lodging_status || primary.lodging_status || '').trim(),
      assignedLodgingArea: String(reg.assigned_lodging_area || primary.assigned_lodging_area || '').trim(),
      notes: String(reg.notes || '').trim(),
      people,
      lodgingAssignments,
      flags,
      guardianPairs
    };
  });

  return {
    registrations: normalized,
    inventoryRows
  };
}

function readSheetObjects_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map((header) => String(header).trim().toLowerCase());
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return values.map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      if (header) obj[header] = row[index];
    });
    return obj;
  });
}

function groupRowsBy_(rows, key) {
  const map = new Map();
  rows.forEach((row) => {
    const value = String(row[key] || '').trim();
    if (!value) return;
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  });
  return map;
}

function collectRegistrationFlags_(people) {
  const flags = [];
  const seen = {};

  people.forEach((person) => {
    const ageGroup = String(person.age_group || '').toLowerCase();
    const lodgingStatus = String(person.lodging_status || '').toLowerCase();
    const guardianLink = String(person.guardian_link_key || person.guardian_registration_id || '').trim();
    const lodgingPreference = String(person.lodging_preference || '').toLowerCase();

    addFlagIfMissing_(flags, seen, ageGroup === 'child' && !guardianLink, 'Child without guardian link');
    addFlagIfMissing_(flags, seen, lodgingStatus === 'waitlist' && lodgingPreference.indexOf('cabin') === 0, 'Waitlisted cabin request');
    addFlagIfMissing_(flags, seen, lodgingStatus === 'manual_review', 'Manual review required');
    addFlagIfMissing_(flags, seen, lodgingPreference && !CONFIG.lodging.validation.validPreferences.includes(lodgingPreference), 'Invalid lodging choice');
  });

  return flags;
}

function addFlagIfMissing_(flags, seen, condition, label) {
  if (!condition || seen[label]) return;
  seen[label] = true;
  flags.push(label);
}

function buildGuardianChildPairs_(people) {
  const guardiansByKey = {};
  const guardiansByRegistration = {};

  people.forEach((person) => {
    const isGuardian = toBoolean_(person.is_guardian);
    if (!isGuardian) return;

    const guardianName = String(person.attendee_name || [person.first_name, person.last_name].filter(Boolean).join(' ').trim()).trim();
    const guardianKey = String(person.guardian_link_key || '').trim();
    const attendeeId = String(person.attendee_id || '').trim();
    if (guardianKey) guardiansByKey[guardianKey] = guardianName;
    if (attendeeId) guardiansByRegistration[attendeeId] = guardianName;
  });

  return people
    .filter((person) => String(person.age_group || '').toLowerCase() === 'child')
    .map((child) => {
      const childName = String(child.attendee_name || [child.first_name, child.last_name].filter(Boolean).join(' ').trim()).trim();
      const guardianKey = String(child.guardian_link_key || '').trim();
      const guardianRegId = String(child.guardian_registration_id || '').trim();
      const linkedGuardian = guardiansByKey[guardianKey] || guardiansByRegistration[guardianRegId] || String(child.guardian_name_reference || '').trim();

      return {
        childName,
        guardianName: linkedGuardian,
        guardianLinkKey: guardianKey,
        guardianRegistrationId: guardianRegId,
        bunkType: String(child.bunk_type || '').trim(),
        lodgingStatus: String(child.lodging_status || '').trim(),
        assignedLodgingArea: String(child.assigned_lodging_area || '').trim()
      };
    });
}


// ============================================================
// SECTION 2 — REPORT BUILDERS
// ============================================================

function generateRegistrationDashboardSheet() {
  const data = getRegistrationReportData_();
  const rows = [
    [
      'registration_id',
      'registration_label',
      'submitted_at',
      'primary_contact',
      'email',
      'phone',
      'attendee_count',
      'adult_count',
      'child_count',
      'guardian_count',
      'lodging_preference',
      'lodging_status',
      'assigned_lodging_area',
      'flags',
      'notes'
    ]
  ];

  data.registrations
    .sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime())
    .forEach((registration) => {
      const counts = summarizePeopleCounts_(registration.people);
      rows.push([
        registration.registrationId,
        registration.registrationLabel,
        registration.timestamp,
        registration.registrantName,
        registration.registrantEmail,
        registration.registrantPhone,
        registration.people.length,
        counts.adult,
        counts.child,
        counts.guardian,
        registration.lodgingPreference,
        registration.lodgingStatus,
        registration.assignedLodgingArea,
        registration.flags.join('; '),
        registration.notes
      ]);
    });

  writeReportSheet_('Registration Dashboard', rows);
  return data.registrations.length;
}

function generateLodgingInventoryReportSheet() {
  const data = getRegistrationReportData_();
  const rows = [[
    'lodging_type',
    'label',
    'used',
    'remaining',
    'capacity',
    'waitlist_count',
    'manual_review_count',
    'notes'
  ]];

  const inventoryByType = {};
  data.inventoryRows.forEach((row) => {
    inventoryByType[String(row.lodging_category || row.lodging_type || '').trim()] = row;
  });

  CONFIG.lodging.inventoryAudit.inventorySummaryRowOrder.forEach((lodgingType) => {
    const definition = getLodgingCategoryDefinition_(lodgingType);
    const inventory = inventoryByType[lodgingType] || {};
    rows.push([
      lodgingType,
      definition.label,
      inventory.used || 0,
      inventory.remaining === '' || inventory.remaining === undefined ? '' : inventory.remaining,
      definition.countsAsUnlimited ? 'unlimited' : definition.publicCapacity,
      countAttendeesByStatus_(data.registrations, lodgingType, 'waitlist'),
      countAttendeesByStatus_(data.registrations, lodgingType, 'manual_review'),
      definition.countsAsUnlimited ? 'Tent capacity is not limited.' : 'Public inventory counts bottom bunks or RV spots only.'
    ]);
  });

  writeReportSheet_('Lodging Inventory Summary', rows);
  return rows.length - 1;
}

function generateAssignedWaitlistReportSheet() {
  const data = getRegistrationReportData_();
  const rows = [[
    'registration_id',
    'registration_label',
    'attendee_id',
    'attendee_name',
    'age_group',
    'is_guardian',
    'lodging_preference',
    'lodging_status',
    'bunk_type',
    'assigned_lodging_area',
    'guardian_link_key',
    'notes'
  ]];

  data.registrations.forEach((registration) => {
    registration.people.forEach((person) => {
      const status = String(person.lodging_status || '').toLowerCase();
      if (!['assigned', 'waitlist', 'pending', 'manual_review'].includes(status)) return;
      rows.push([
        registration.registrationId,
        registration.registrationLabel,
        person.attendee_id || '',
        person.attendee_name || [person.first_name, person.last_name].filter(Boolean).join(' ').trim(),
        person.age_group || '',
        person.is_guardian || '',
        person.lodging_preference || '',
        person.lodging_status || '',
        person.bunk_type || '',
        person.assigned_lodging_area || '',
        person.guardian_link_key || '',
        person.notes || ''
      ]);
    });
  });

  writeReportSheet_('Assigned vs Waitlisted', rows);
  return rows.length - 1;
}

function generateGuardianChildPairingReportSheet() {
  const data = getRegistrationReportData_();
  const rows = [[
    'registration_id',
    'registration_label',
    'child_name',
    'guardian_name',
    'guardian_link_key',
    'guardian_registration_id',
    'lodging_status',
    'bunk_type',
    'assigned_lodging_area',
    'attention_needed'
  ]];

  data.registrations.forEach((registration) => {
    registration.guardianPairs.forEach((pair) => {
      rows.push([
        registration.registrationId,
        registration.registrationLabel,
        pair.childName,
        pair.guardianName,
        pair.guardianLinkKey,
        pair.guardianRegistrationId,
        pair.lodgingStatus,
        pair.bunkType,
        pair.assignedLodgingArea,
        pair.guardianName ? '' : 'Missing linked guardian'
      ]);
    });
  });

  writeReportSheet_('Guardian Child Pairing', rows);
  return rows.length - 1;
}

function generateRvTentCountsSheet() {
  const data = getRegistrationReportData_();
  const rows = [[
    'metric',
    'count'
  ]];

  rows.push(['rv_assigned', countAttendeesByPreferenceAndStatus_(data.registrations, 'rv_hookups', 'assigned')]);
  rows.push(['rv_waitlist', countAttendeesByPreferenceAndStatus_(data.registrations, 'rv_hookups', 'waitlist')]);
  rows.push(['tent_attendees', countAttendeesByPreference_(data.registrations, 'tent_no_hookups')]);
  rows.push(['tent_registrations', countRegistrationsByPreference_(data.registrations, 'tent_no_hookups')]);
  rows.push(['shared_cabin_detached_assigned', countAttendeesByPreferenceAndStatus_(data.registrations, 'shared_cabin_detached', 'assigned')]);
  rows.push(['shared_cabin_connected_assigned', countAttendeesByPreferenceAndStatus_(data.registrations, 'shared_cabin_connected', 'assigned')]);
  rows.push(['sabbath_only_registrations', countRegistrationsByPreference_(data.registrations, 'sabbath_attendance_only')]);
  rows.push(['young_mens_participants', countAttendeesByProgramType_(data.registrations, 'young_mens')]);
  rows.push(['minor_registrations', countMinorAttendees_(data.registrations)]);

  writeReportSheet_('RV and Tent Counts', rows);
  return rows.length - 1;
}


// ============================================================
// SECTION 3 — LEGACY ENTRY POINTS
// ============================================================

function generateClubDashboardSheet() {
  return generateRegistrationDashboardSheet();
}

function generateCampingCoordinatorSheet() {
  return generateLodgingInventoryReportSheet();
}

function generateAllReportSheets() {
  const results = {
    registrationDashboard: 0,
    lodgingInventory: 0,
    assignedWaitlist: 0,
    guardianChildPairing: 0,
    rvTentCounts: 0,
    errors: []
  };

  const tasks = [
    ['registrationDashboard', generateRegistrationDashboardSheet],
    ['lodgingInventory', generateLodgingInventoryReportSheet],
    ['assignedWaitlist', generateAssignedWaitlistReportSheet],
    ['guardianChildPairing', generateGuardianChildPairingReportSheet],
    ['rvTentCounts', generateRvTentCountsSheet]
  ];

  tasks.forEach(([key, fn]) => {
    try {
      results[key] = fn();
    } catch (err) {
      results.errors.push(key + ': ' + err.toString());
    }
  });

  // Legacy compatibility field name retained for callers that still expect "clubs".
  results.clubs = results.registrationDashboard;
  Logger.log('generateAllReportSheets complete: ' + JSON.stringify(results));
  return results;
}

function testReportsWithFakeData() {
  throw new Error('testReportsWithFakeData is deprecated. Use live Man Camp data to validate lodging reports.');
}


// ============================================================
// SECTION 4 — HELPERS
// ============================================================

function writeReportSheet_(sheetName, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(sheetName);

  if (!rows.length) {
    sheet.getRange(1, 1).setValue('No data available.');
    return;
  }

  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, rows[0].length);
  sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold').setBackground('#d9e8f7');
  if (rows.length > 1) {
    sheet.getRange(1, 1, rows.length, rows[0].length).createFilter();
  }
}

function summarizePeopleCounts_(people) {
  return people.reduce((acc, person) => {
    const ageGroup = String(person.age_group || '').toLowerCase();
    if (ageGroup === 'child') {
      acc.child++;
    } else {
      acc.adult++;
    }

    if (toBoolean_(person.is_guardian)) {
      acc.guardian++;
    }
    return acc;
  }, { adult: 0, child: 0, guardian: 0 });
}

function countAttendeesByStatus_(registrations, lodgingType, status) {
  return registrations.reduce((sum, registration) => {
    return sum + registration.people.filter((person) => {
      return String(person.lodging_preference || '').toLowerCase() === lodgingType
        && String(person.lodging_status || '').toLowerCase() === status;
    }).length;
  }, 0);
}

function countAttendeesByPreference_(registrations, lodgingType) {
  return registrations.reduce((sum, registration) => {
    return sum + registration.people.filter((person) => {
      return String(person.lodging_preference || '').toLowerCase() === lodgingType;
    }).length;
  }, 0);
}

function countAttendeesByPreferenceAndStatus_(registrations, lodgingType, status) {
  return registrations.reduce((sum, registration) => {
    return sum + registration.people.filter((person) => {
      return String(person.lodging_preference || '').toLowerCase() === lodgingType
        && String(person.lodging_status || '').toLowerCase() === status;
    }).length;
  }, 0);
}

function countRegistrationsByPreference_(registrations, lodgingType) {
  return registrations.filter((registration) => {
    return registration.people.some((person) => String(person.lodging_preference || '').toLowerCase() === lodgingType);
  }).length;
}

function countAttendeesByProgramType_(registrations, programType) {
  return registrations.reduce((sum, registration) => {
    return sum + registration.people.filter((person) => {
      return String(person.program_type || '').toLowerCase() === programType;
    }).length;
  }, 0);
}

function countMinorAttendees_(registrations) {
  return registrations.reduce((sum, registration) => {
    return sum + registration.people.filter((person) => {
      const age = Number(person.age || '');
      return String(person.is_minor || '').toLowerCase() === 'yes' || (!isNaN(age) && age < CONFIG.ageRules.adultMinAge);
    }).length;
  }, 0);
}

function getLodgingCategoryDefinition_(lodgingType) {
  const categories = CONFIG.lodging.categories;
  const keys = Object.keys(categories);
  for (let i = 0; i < keys.length; i++) {
    if (categories[keys[i]].key === lodgingType) return categories[keys[i]];
  }
  return {
    key: lodgingType,
    label: lodgingType,
    publicCapacity: '',
    countsAsUnlimited: false
  };
}

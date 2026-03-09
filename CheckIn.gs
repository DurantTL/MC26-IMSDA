// ============================================================
// Man Camp Registration System
// Google Apps Script — CheckIn.gs
//
// Individual lodging-aware check-in for on-site volunteers.
// Check-in state is stored on Roster rows and mirrored to
// LodgingAssignments for auditability. Registration-level
// check-in fields remain as a summary rollup only.
// ============================================================

/**
 * Returns attendee-level check-in candidates for a registration.
 *
 * @param {string} registrationId
 * @returns {Object}
 */
function getRegistrationCheckInList(registrationId) {
  try {
    if (!registrationId) return { success: false, message: 'No registration ID provided.' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
    if (!regSheet || !rosterSheet) return { success: false, message: 'Required sheets not found.' };

    ensureIndividualCheckInColumns_(ss);

    const regRow = findRegistrationRow_(regSheet, registrationId);
    if (regRow < 0) return { success: false, message: 'Registration not found: ' + registrationId };

    const reg = readRowAsObject_(regSheet, regRow);
    const people = readPeopleForRegistrationFromRoster_(rosterSheet, registrationId);
    const primaryContactName = [reg['first_name'] || '', reg['last_name'] || ''].join(' ').trim() || String(reg['registrant_name'] || '');
    const registrationLabel = String(reg['registration_label'] || reg['club_name'] || primaryContactName || 'Registration');

    const attendees = people.map(buildCheckInAttendeeResult_);
    return {
      success: true,
      registrationId: registrationId,
      registrationLabel: registrationLabel,
      primaryContactName: primaryContactName,
      attendees: attendees,
      summary: summarizeCheckInRoster_(attendees)
    };
  } catch (err) {
    return { success: false, message: 'Error loading check-in list: ' + err.toString() };
  }
}

/**
 * Checks in a single attendee, preventing duplicates and blocking
 * waitlist/manual-review attendees from being treated as assigned.
 *
 * @param {string} registrationId
 * @param {string} attendeeId
 * @returns {Object}
 */
function processAttendeeCheckIn(registrationId, attendeeId) {
  try {
    if (!registrationId || !attendeeId) {
      return { success: false, message: 'Registration ID and attendee ID are required.' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
    const lodgingSheet = ss.getSheetByName(CONFIG.sheets.lodgingAssignments);
    if (!regSheet || !rosterSheet) return { success: false, message: 'Required sheets not found.' };

    ensureIndividualCheckInColumns_(ss);

    const regRowNum = findRegistrationRow_(regSheet, registrationId);
    if (regRowNum < 0) return { success: false, message: 'Registration not found: ' + registrationId };
    const reg = readRowAsObject_(regSheet, regRowNum);

    const rosterLookup = findRosterAttendeeRow_(rosterSheet, registrationId, attendeeId);
    if (rosterLookup.rowNum < 0) {
      return { success: false, message: 'Attendee not found for this registration.' };
    }

    const attendee = buildCheckInAttendeeResult_(rosterLookup.person);
    const now = new Date();
    const nowDisplay = formatCheckInTimestamp_(now);

    if (attendee.checkInStatus === 'arrived') {
      return {
        success: false,
        alreadyCheckedIn: true,
        registrationId: registrationId,
        attendeeId: attendeeId,
        attendeeName: attendee.attendeeName,
        checkInTimestamp: attendee.checkInTimestampDisplay || 'earlier',
        message: attendee.attendeeName + ' is already checked in.'
      };
    }

    if (attendee.lodgingStatus === 'waitlist') {
      return {
        success: false,
        blocked: true,
        registrationId: registrationId,
        attendeeId: attendeeId,
        attendeeName: attendee.attendeeName,
        message: attendee.attendeeName + ' is waitlisted and cannot be checked in as assigned.',
        lodgingStatus: attendee.lodgingStatus,
        flags: attendee.flags
      };
    }

    if (attendee.lodgingStatus === 'manual_review') {
      return {
        success: false,
        blocked: true,
        registrationId: registrationId,
        attendeeId: attendeeId,
        attendeeName: attendee.attendeeName,
        message: attendee.attendeeName + ' requires manual lodging review before check-in.',
        lodgingStatus: attendee.lodgingStatus,
        flags: attendee.flags
      };
    }

    updateRowFromObject_(rosterSheet, rosterLookup.rowNum, {
      check_in_status: 'Arrived',
      check_in_timestamp: now
    });

    syncAttendeeCheckInToLodgingAssignments_(lodgingSheet, registrationId, attendeeId, now);
    updateRegistrationCheckInRollup_(ss, registrationId);

    const refreshed = getCheckInAttendeeById_(ss, registrationId, attendeeId);
    return {
      success: true,
      message: refreshed.attendeeName + ' checked in successfully.',
      registrationId: registrationId,
      attendeeId: attendeeId,
      attendeeName: refreshed.attendeeName,
      lodgingPreference: refreshed.lodgingPreference,
      lodgingStatus: refreshed.lodgingStatus,
      bunkType: refreshed.bunkType,
      assignedLodgingArea: refreshed.assignedLodgingArea,
      notes: refreshed.notes,
      flags: refreshed.flags,
      checkInTimestamp: nowDisplay,
      registrationSummary: getRegistrationCheckInList(registrationId).summary
    };
  } catch (err) {
    return { success: false, message: 'Error during attendee check-in: ' + err.toString() };
  }
}

/**
 * Backward-compatible wrapper. Checks in all eligible attendees in a registration.
 * This is kept so older UI/hooks do not fail outright.
 *
 * @param {string} registrationId
 * @returns {Object}
 */
function processClubCheckIn(registrationId) {
  const listResult = getRegistrationCheckInList(registrationId);
  if (!listResult.success) return listResult;

  const assigned = listResult.attendees.filter(att => att.lodgingStatus === 'assigned' && att.checkInStatus !== 'arrived');
  const blocked = listResult.attendees.filter(att => att.lodgingStatus !== 'assigned');

  if (assigned.length === 0) {
    return {
      success: false,
      blocked: true,
      registrationId: registrationId,
      message: blocked.length
        ? 'No assigned attendees are eligible for check-in on this registration.'
        : 'Everyone on this registration is already checked in.',
      attendees: listResult.attendees,
      summary: listResult.summary
    };
  }

  const successes = [];
  for (let i = 0; i < assigned.length; i++) {
    const result = processAttendeeCheckIn(registrationId, assigned[i].attendeeId);
    if (result.success) successes.push(result.attendeeName);
  }

  const refreshed = getRegistrationCheckInList(registrationId);
  return {
    success: true,
    registrationId: registrationId,
    message: 'Checked in ' + successes.length + ' attendee(s).',
    checkedInAttendees: successes,
    attendees: refreshed.attendees,
    summary: refreshed.summary
  };
}

function ensureIndividualCheckInColumns_(ss) {
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  const lodgingSheet = ss.getSheetByName(CONFIG.sheets.lodgingAssignments);
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (rosterSheet) ensureSheetHeaders_(rosterSheet, getRosterHeaders_());
  if (lodgingSheet) ensureSheetHeaders_(lodgingSheet, getLodgingAssignmentsHeaders_());
  if (regSheet) ensureRegistrationCheckInColumns_(regSheet);
}

function ensureRegistrationCheckInColumns_(sheet) {
  ensureSheetHeaders_(sheet, getRegistrationsHeaders_().concat(['check_in_status', 'check_in_timestamp']));
}

function findRosterAttendeeRow_(sheet, registrationId, attendeeId) {
  if (!sheet || sheet.getLastRow() < 2) return { rowNum: -1, person: null };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const colMap = getColumnMap_(sheet);
  for (let i = 0; i < rows.length; i++) {
    if (
      String(rows[i][colMap['registration_id']] || '') === registrationId &&
      String(rows[i][colMap['attendee_id']] || '') === attendeeId
    ) {
      return {
        rowNum: i + 2,
        person: readPeopleForRegistrationFromRoster_(sheet, registrationId).find(person => person.id === attendeeId) || null
      };
    }
  }
  return { rowNum: -1, person: null };
}

function syncAttendeeCheckInToLodgingAssignments_(sheet, registrationId, attendeeId, timestamp) {
  if (!sheet || sheet.getLastRow() < 2) return;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const colMap = getColumnMap_(sheet);
  for (let i = 0; i < rows.length; i++) {
    if (
      String(rows[i][colMap['registration_id']] || '') === registrationId &&
      String(rows[i][colMap['attendee_id']] || '') === attendeeId
    ) {
      updateRowFromObject_(sheet, i + 2, {
        check_in_status: 'Arrived',
        check_in_timestamp: timestamp,
        updated_at: new Date()
      });
      return;
    }
  }
}

function updateRegistrationCheckInRollup_(ss, registrationId) {
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!rosterSheet || !regSheet) return;

  const people = readPeopleForRegistrationFromRoster_(rosterSheet, registrationId);
  const eligible = people.filter(person => String(person.lodgingStatus || '').toLowerCase() === 'assigned');
  const arrived = eligible.filter(person => String(person.checkInStatus || '').toLowerCase() === 'arrived');
  const latestTimestamp = arrived.reduce(function(latest, person) {
    if (!person.checkInTimestamp) return latest;
    const currentMs = new Date(person.checkInTimestamp).getTime();
    const latestMs = latest ? new Date(latest).getTime() : 0;
    return currentMs > latestMs ? person.checkInTimestamp : latest;
  }, '');

  const rowNum = findRegistrationRow_(regSheet, registrationId);
  if (rowNum < 0) return;
  updateRowFromObject_(regSheet, rowNum, {
    check_in_status: eligible.length && arrived.length === eligible.length
      ? 'Arrived'
      : (arrived.length ? 'Partially Arrived' : ''),
    check_in_timestamp: latestTimestamp || ''
  });
}

function getCheckInAttendeeById_(ss, registrationId, attendeeId) {
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  const people = rosterSheet ? readPeopleForRegistrationFromRoster_(rosterSheet, registrationId) : [];
  const person = people.find(item => item.id === attendeeId);
  return buildCheckInAttendeeResult_(person || { id: attendeeId, name: attendeeId });
}

function buildCheckInAttendeeResult_(person) {
  const flags = [];
  if (!person) {
    return {
      attendeeId: '',
      attendeeName: '',
      lodgingPreference: '',
      lodgingStatus: '',
      bunkType: '',
      assignedLodgingArea: '',
      notes: '',
      flags: [{ code: 'missing_attendee', label: 'Attendee not found' }],
      checkInStatus: '',
      checkInTimestamp: '',
      checkInTimestampDisplay: ''
    };
  }

  if (person.ageGroup === 'child' && !person.isGuardian && !person.guardianLinkKey && !person.guardianRegistrationId) {
    flags.push({ code: 'child_without_guardian', label: 'Child without guardian link' });
  }
  if (String(person.lodgingStatus || '').toLowerCase() === 'waitlist') {
    flags.push({ code: 'waitlist', label: 'Waitlisted lodging request' });
  }
  if (String(person.lodgingStatus || '').toLowerCase() === 'manual_review') {
    flags.push({ code: 'manual_review', label: 'Manual review required' });
  }

  return {
    attendeeId: person.id || '',
    attendeeName: person.name || '',
    lodgingPreference: person.lodgingPreference || '',
    lodgingStatus: String(person.lodgingStatus || '').toLowerCase(),
    bunkType: person.bunkType || 'none',
    assignedLodgingArea: person.assignedLodgingArea || '',
    notes: person.notes || '',
    flags: flags,
    assignmentReason: person.assignmentReason || '',
    checkInStatus: String(person.checkInStatus || '').toLowerCase(),
    checkInTimestamp: person.checkInTimestamp || '',
    checkInTimestampDisplay: person.checkInTimestamp ? formatCheckInTimestamp_(person.checkInTimestamp) : '',
    guardianSummary: person.isGuardian
      ? 'Guardian'
      : (person.guardianLinkKey ? 'Linked by guardian key' : (person.guardianRegistrationId ? 'Linked guardian registration' : 'No guardian link'))
  };
}

function summarizeCheckInRoster_(attendees) {
  const eligible = attendees.filter(att => att.lodgingStatus === 'assigned');
  const arrived = eligible.filter(att => att.checkInStatus === 'arrived');
  return {
    total: attendees.length,
    eligible: eligible.length,
    arrived: arrived.length,
    blocked: attendees.filter(att => att.lodgingStatus === 'waitlist' || att.lodgingStatus === 'manual_review').length
  };
}

function formatCheckInTimestamp_(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

// ============================================================
// Man Camp Registration System
// Google Apps Script — Lodging.gs
// Centralized lodging inventory and bunk assignment helpers.
// ============================================================

function seedLodgingInventorySheet_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.length === 0) return;

  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    : [];
  const existingMap = new Map(existing.map((row, idx) => [String(row[0] || '').trim(), idx + 2]));

  getLodgingDefinitions_().forEach(def => {
    const rowObj = buildInventorySummaryRow_(def, {
      assignedPublicUnits: 0,
      assignedTopBunks: 0,
      waitlistCount: 0,
      manualReviewCount: 0,
      remainingPublicCapacity: def.isUnlimited ? 'Unlimited' : def.publicCapacity,
      lastRecalculatedAt: '',
      notes: ''
    });

    if (existingMap.has(def.key)) {
      const rowNum = existingMap.get(def.key);
      // Do not overwrite public_capacity for existing rows — admins may have edited it directly.
      updateRowFromObject_(sheet, rowNum, {
        lodging_category: rowObj.lodging_category,
        label: rowObj.label,
        inventory_type: rowObj.inventory_type,
        is_unlimited: rowObj.is_unlimited
      });
    } else {
      appendRowFromObject_(sheet, rowObj);
    }
  });
}

function getLodgingDefinitions_() {
  return [
    {
      key: CONFIG.lodging.categories.sharedCabinDetached.key,
      label: CONFIG.lodging.categories.sharedCabinDetached.label,
      inventoryType: CONFIG.lodging.categories.sharedCabinDetached.inventoryType,
      publicCapacity: CONFIG.lodging.capacities.sharedCabinDetachedBottomBunks,
      isUnlimited: false
    },
    {
      key: CONFIG.lodging.categories.sharedCabinConnected.key,
      label: CONFIG.lodging.categories.sharedCabinConnected.label,
      inventoryType: CONFIG.lodging.categories.sharedCabinConnected.inventoryType,
      publicCapacity: CONFIG.lodging.capacities.sharedCabinConnectedBottomBunks,
      isUnlimited: false
    },
    {
      key: CONFIG.lodging.categories.rvHookups.key,
      label: CONFIG.lodging.categories.rvHookups.label,
      inventoryType: CONFIG.lodging.categories.rvHookups.inventoryType,
      publicCapacity: CONFIG.lodging.capacities.rvHookupSpots,
      isUnlimited: false
    },
    {
      key: CONFIG.lodging.categories.tentNoHookups.key,
      label: CONFIG.lodging.categories.tentNoHookups.label,
      inventoryType: CONFIG.lodging.categories.tentNoHookups.inventoryType,
      publicCapacity: '',
      isUnlimited: !!CONFIG.lodging.capacities.tentUnlimited
    },
    {
      key: CONFIG.lodging.categories.sabbathOnly.key,
      label: CONFIG.lodging.categories.sabbathOnly.label,
      inventoryType: CONFIG.lodging.categories.sabbathOnly.inventoryType,
      publicCapacity: '',
      isUnlimited: !!CONFIG.lodging.capacities.sabbathOnlyUnlimited
    }
  ];
}

function getLodgingDefinitionByPreference_(lodgingPreference) {
  return getLodgingDefinitions_().find(def => def.key === lodgingPreference) || null;
}

function checkLodgingCapacity(ss, lodgingPreference, requestedUnits, excludeRegistrationId) {
  const definition = getLodgingDefinitionByPreference_(lodgingPreference);
  if (!definition) {
    return {
      valid: false,
      reason: 'Unknown lodging option.',
      availableUnits: 0,
      requestedUnits: requestedUnits
    };
  }

  if (definition.isUnlimited) {
    return {
      valid: true,
      reason: '',
      availableUnits: Number.MAX_SAFE_INTEGER,
      requestedUnits: requestedUnits
    };
  }

  const inventory = calculateRemainingInventory(ss, excludeRegistrationId);
  const categoryStats = inventory.byCategory[definition.key] || {};
  const availableUnits = typeof categoryStats.remainingPublicCapacity === 'number'
    ? categoryStats.remainingPublicCapacity
    : definition.publicCapacity;

  return {
    valid: true,
    reason: '',
    availableUnits: availableUnits,
    requestedUnits: requestedUnits
  };
}

function assignLodging(ss, registrationData, options) {
  const opts = options || {};
  const excludeRegistrationId = opts.excludeRegistrationId || registrationData.registrationId || '';
  const people = (registrationData.people || registrationData.roster || []).map(person => Object.assign({}, person));
  if (people.length === 0) throw new Error('Cannot assign lodging without participant records.');

  const lodgingPreference = normalizeLodgingPreference_(registrationData.lodgingPreference || '');
  const definition = getLodgingDefinitionByPreference_(lodgingPreference);

  if (!definition) {
    people.forEach(person => {
      setAssignmentOnPerson_(person, {
        lodgingStatus: 'manual_review',
        bunkType: 'none',
        assignedLodgingArea: '',
        consumesPublicInventory: false,
        inventoryCategory: '',
        assignmentReason: 'Unknown lodging option.'
      });
    });
    return buildAssignedRegistration_(registrationData, people, lodgingPreference, 'manual_review');
  }

  if (definition.key === CONFIG.lodging.categories.tentNoHookups.key) {
    people.forEach(person => {
      setAssignmentOnPerson_(person, {
        lodgingStatus: 'assigned',
        bunkType: 'tent',
        assignedLodgingArea: registrationData.assignedLodgingArea || '',
        consumesPublicInventory: false,
        inventoryCategory: definition.key,
        assignmentReason: 'Tent lodging is unlimited.'
      });
    });
    return buildAssignedRegistration_(registrationData, people, lodgingPreference, 'assigned');
  }

  if (definition.key === CONFIG.lodging.categories.sabbathOnly.key) {
    people.forEach(person => {
      setAssignmentOnPerson_(person, {
        lodgingStatus: 'assigned',
        bunkType: 'day_only',
        assignedLodgingArea: '',
        consumesPublicInventory: false,
        inventoryCategory: definition.key,
        assignmentReason: 'Sabbath Attendance only does not consume overnight lodging inventory.'
      });
    });
    return buildAssignedRegistration_(registrationData, people, lodgingPreference, 'assigned');
  }

  if (definition.key === CONFIG.lodging.categories.rvHookups.key) {
    const rvCapacity = checkLodgingCapacity(ss, definition.key, 1, excludeRegistrationId);
    const canAssign = rvCapacity.availableUnits > 0;
    people.forEach((person, idx) => {
      setAssignmentOnPerson_(person, {
        lodgingStatus: canAssign ? 'assigned' : 'waitlist',
        bunkType: canAssign ? 'rv' : 'none',
        assignedLodgingArea: registrationData.assignedLodgingArea || '',
        consumesPublicInventory: canAssign && idx === 0,
        inventoryCategory: definition.key,
        assignmentReason: canAssign
          ? 'Assigned RV spot from public inventory.'
          : 'RV spots are unavailable.'
      });
    });
    return buildAssignedRegistration_(registrationData, people, lodgingPreference, canAssign ? 'assigned' : 'waitlist');
  }

  return applyGuardianChildBunkRules(ss, registrationData, people, definition, excludeRegistrationId);
}

function applyGuardianChildBunkRules(ss, registrationData, people, definition, excludeRegistrationId) {
  const adults = people.filter(person => person.ageGroup === 'adult' || person.isGuardian);
  const children = people.filter(person => person.ageGroup === 'child' && !person.isGuardian);

  const capacity = checkLodgingCapacity(ss, definition.key, adults.length, excludeRegistrationId);
  let availableBottomBunks = Math.max(0, capacity.availableUnits);

  adults.forEach(person => {
    if (availableBottomBunks > 0) {
      availableBottomBunks--;
      setAssignmentOnPerson_(person, {
        lodgingStatus: 'assigned',
        bunkType: 'bottom',
        assignedLodgingArea: registrationData.assignedLodgingArea || '',
        consumesPublicInventory: true,
        inventoryCategory: definition.key,
        assignmentReason: 'Assigned bottom bunk from public inventory.'
      });
    } else {
      setAssignmentOnPerson_(person, {
        lodgingStatus: 'waitlist',
        bunkType: 'none',
        assignedLodgingArea: '',
        consumesPublicInventory: false,
        inventoryCategory: definition.key,
        assignmentReason: 'Bottom-bunk capacity exhausted.'
      });
    }
  });

  children.forEach(child => {
    const guardianMatch = resolveGuardianLinkForChild_(ss, child, adults);
    if (!guardianMatch.isLinked) {
      setAssignmentOnPerson_(child, {
        lodgingStatus: 'manual_review',
        bunkType: 'none',
        assignedLodgingArea: '',
        consumesPublicInventory: false,
        inventoryCategory: definition.key,
        assignmentReason: guardianMatch.reason
      });
      return;
    }

    if (guardianMatch.guardian && guardianMatch.guardian.lodgingStatus === 'assigned') {
      setAssignmentOnPerson_(child, {
        lodgingStatus: 'assigned',
        bunkType: 'top_guardian_child',
        assignedLodgingArea: guardianMatch.guardian.assignedLodgingArea || registrationData.assignedLodgingArea || '',
        consumesPublicInventory: false,
        inventoryCategory: definition.key,
        assignmentReason: 'Assigned top bunk linked to guardian; top bunks do not consume public inventory.'
      });
      return;
    }

    setAssignmentOnPerson_(child, {
      lodgingStatus: 'waitlist',
      bunkType: 'none',
      assignedLodgingArea: '',
      consumesPublicInventory: false,
      inventoryCategory: definition.key,
      assignmentReason: 'Linked guardian is not yet assigned a bottom bunk.'
    });
  });

  return buildAssignedRegistration_(registrationData, people, definition.key, deriveRegistrationLodgingStatus_(people));
}

function calculateRemainingInventory(ss, excludeRegistrationId) {
  const definitions = getLodgingDefinitions_();
  const byCategory = {};
  definitions.forEach(def => {
    byCategory[def.key] = {
      definition: Object.assign({}, def),
      assignedPublicUnits: 0,
      assignedTopBunks: 0,
      waitlistCount: 0,
      manualReviewCount: 0,
      remainingPublicCapacity: def.isUnlimited ? 'Unlimited' : def.publicCapacity
    };
  });

  // Override publicCapacity from the LodgingInventory sheet so admins can
  // adjust spot counts there without editing code. Config.gs values are the
  // initial seed only; the sheet is the authoritative source once seeded.
  const inventorySheet = ss.getSheetByName(CONFIG.sheets.lodgingInventory);
  if (inventorySheet && inventorySheet.getLastRow() > 1) {
    const invRows = inventorySheet.getRange(2, 1, inventorySheet.getLastRow() - 1, inventorySheet.getLastColumn()).getValues();
    const invColMap = getColumnMap_(inventorySheet);
    invRows.forEach(function(row) {
      const cat = String(row[invColMap['lodging_category']] || '').trim();
      const capRaw = row[invColMap['public_capacity']];
      const isUnlimited = String(row[invColMap['is_unlimited']] || '').trim().toLowerCase() === 'yes';
      if (cat && byCategory[cat] && !isUnlimited && capRaw !== '' && capRaw !== null) {
        const cap = Number(capRaw);
        if (!isNaN(cap)) {
          byCategory[cat].definition.publicCapacity = cap;
          byCategory[cat].remainingPublicCapacity = cap;
        }
      }
    });
  }

  const sheet = ss.getSheetByName(CONFIG.sheets.lodgingAssignments);
  if (!sheet || sheet.getLastRow() < 2) {
    return { byCategory: byCategory };
  }

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const colMap = getColumnMap_(sheet);

  rows.forEach(row => {
    const registrationId = String(row[colMap['registration_id']] || '');
    if (excludeRegistrationId && registrationId === excludeRegistrationId) return;

    const category = String(row[colMap['inventory_category']] || '').trim();
    if (!category || !byCategory[category]) return;

    const status = String(row[colMap['lodging_status']] || '').trim().toLowerCase();
    const bunkType = String(row[colMap['bunk_type']] || '').trim().toLowerCase();
    const consumesPublic = String(row[colMap['consumes_public_inventory']] || '').trim().toLowerCase() === 'yes';

    if (status === 'assigned' && consumesPublic) byCategory[category].assignedPublicUnits++;
    if (status === 'assigned' && bunkType === 'top_guardian_child') byCategory[category].assignedTopBunks++;
    if (status === 'waitlist') byCategory[category].waitlistCount++;
    if (status === 'manual_review') byCategory[category].manualReviewCount++;
  });

  Object.keys(byCategory).forEach(category => {
    const stats = byCategory[category];
    if (!stats.definition.isUnlimited) {
      stats.remainingPublicCapacity = Math.max(0, stats.definition.publicCapacity - stats.assignedPublicUnits);
    }
  });

  return { byCategory: byCategory };
}

function persistLodgingAssignments_(ss, registrationData) {
  const sheet = ss.getSheetByName(CONFIG.sheets.lodgingAssignments);
  if (!sheet) return;

  deleteRowsByRegistrationId_(sheet, registrationData.registrationId);

  (registrationData.people || []).forEach(person => {
    appendRowFromObject_(sheet, {
      registration_id:           registrationData.registrationId,
      attendee_id:               person.id || '',
      full_name:                 person.name || '',
      age_group:                 person.ageGroup || '',
      is_guardian:               person.isGuardian ? 'Yes' : 'No',
      guardian_link_key:         person.guardianLinkKey || '',
      guardian_registration_id:  person.guardianRegistrationId || '',
      own_link_key:              person.ownLinkKey || '',
      lodging_preference:        person.lodgingPreference || registrationData.lodgingPreference || '',
      lodging_option_key:        person.lodgingOptionKey || registrationData.lodgingOptionKey || '',
      lodging_option_label:      person.lodgingOptionLabel || registrationData.lodgingOptionLabel || '',
      attendance_type:           person.attendanceType || registrationData.attendanceType || '',
      program_type:              person.programType || registrationData.programType || '',
      shirt_size:                person.shirtSize || '',
      lodging_status:            person.lodgingStatus || registrationData.lodgingStatus || '',
      bunk_type:                 person.bunkType || 'none',
      assigned_lodging_area:     person.assignedLodgingArea || '',
      inventory_category:        person.inventoryCategory || '',
      consumes_public_inventory: person.consumesPublicInventory ? 'Yes' : 'No',
      assignment_reason:         person.assignmentReason || '',
      created_at:                registrationData.createdAt || registrationData.timestamp || new Date(),
      updated_at:                new Date(),
      check_in_status:           person.checkInStatus === 'arrived' ? 'Arrived' : '',
      check_in_timestamp:        person.checkInTimestamp || ''
    });
  });
}

function refreshLodgingInventorySheet_(ss) {
  const sheet = ss.getSheetByName(CONFIG.sheets.lodgingInventory);
  if (!sheet) return;

  seedLodgingInventorySheet_(sheet);
  const inventory = calculateRemainingInventory(ss);
  const existingRows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    : [];

  existingRows.forEach((row, idx) => {
    const category = String(row[0] || '').trim();
    const stats = inventory.byCategory[category];
    if (!stats) return;
    const rowNum = idx + 2;
    updateRowFromObject_(sheet, rowNum, buildInventorySummaryRow_(stats.definition, {
      assignedPublicUnits: stats.assignedPublicUnits,
      assignedTopBunks: stats.assignedTopBunks,
      waitlistCount: stats.waitlistCount,
      manualReviewCount: stats.manualReviewCount,
      remainingPublicCapacity: stats.remainingPublicCapacity,
      lastRecalculatedAt: new Date(),
      notes: ''
    }));
  });
}

function rebuildLodgingStateForRegistration_(ss, registrationId) {
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!regSheet || !rosterSheet) return;

  const regRowIndex = findRegistrationRow_(regSheet, registrationId);
  if (regRowIndex < 0) return;

  const reg = readRowAsObject_(regSheet, regRowIndex);
  const people = readPeopleForRegistrationFromRoster_(rosterSheet, registrationId);
  if (people.length === 0) {
    deleteRowsByRegistrationId_(ss.getSheetByName(CONFIG.sheets.lodgingAssignments), registrationId);
    refreshLodgingInventorySheet_(ss);
    return;
  }

  const assigned = assignLodging(ss, {
    registrationId: registrationId,
    registrationLabel: reg['club_name'] || reg['registrant_name'] || 'Registration',
    registrantName: reg['registrant_name'] || '',
    registrantEmail: reg['registrant_email'] || reg['email'] || '',
    registrantPhone: reg['registrant_phone'] || reg['phone'] || '',
    lodgingPreference: reg['lodging_preference'] || people[0].lodgingPreference || 'tent_no_hookups',
    assignedLodgingArea: reg['assigned_lodging_area'] || reg['camping_location'] || '',
    notes: reg['notes'] || '',
    createdAt: reg['created_at'] || reg['timestamp'] || new Date(),
    timestamp: reg['timestamp'] || new Date(),
    people: people,
    roster: people
  }, { excludeRegistrationId: registrationId });

  persistLodgingAssignments_(ss, assigned);
  updateRegistrationAndRosterLodgingFields_(ss, regSheet, rosterSheet, regRowIndex, assigned);
  updateSummaryRowsForRegistration_(ss, assigned);
  refreshLodgingInventorySheet_(ss);
}

function updateRegistrationAndRosterLodgingFields_(ss, regSheet, rosterSheet, regRowIndex, assigned) {
  updateRowFromObject_(regSheet, regRowIndex, {
    lodging_preference: assigned.lodgingPreference,
    lodging_option_key: assigned.lodgingOptionKey || assigned.lodgingPreference,
    lodging_option_label: assigned.lodgingOptionLabel || '',
    attendance_type: assigned.attendanceType || '',
    program_type: assigned.programType || '',
    shirt_size: assigned.shirtSize || '',
    lodging_status: assigned.lodgingStatus,
    bunk_type: assigned.bunkTypeSummary,
    assigned_lodging_area: assigned.assignedLodgingArea || '',
    notes: assigned.notes || '',
    roster_json: JSON.stringify(assigned.people || []),
    attendees_json: JSON.stringify(assigned.people || []),
    registration_json: JSON.stringify({
      registration_id: assigned.registrationId,
      registration_label: assigned.registrationLabel,
      lodging_preference: assigned.lodgingPreference,
      lodging_option_key: assigned.lodgingOptionKey || assigned.lodgingPreference,
      lodging_option_label: assigned.lodgingOptionLabel || '',
      attendance_type: assigned.attendanceType || '',
      program_type: assigned.programType || '',
      shirt_size: assigned.shirtSize || '',
      lodging_status: assigned.lodgingStatus,
      bunk_type_summary: assigned.bunkTypeSummary,
      assigned_lodging_area: assigned.assignedLodgingArea || '',
      created_at: assigned.createdAt || assigned.timestamp || new Date()
    })
  });

  if (rosterSheet.getLastRow() < 2) return;
  const data = rosterSheet.getRange(2, 1, rosterSheet.getLastRow() - 1, rosterSheet.getLastColumn()).getValues();
  const colMap = getColumnMap_(rosterSheet);
  const updatesById = {};
  (assigned.people || []).forEach(person => { updatesById[person.id] = person; });

  data.forEach((row, idx) => {
    if (String(row[colMap['registration_id']] || '') !== assigned.registrationId) return;
    const attendeeId = String(row[colMap['attendee_id']] || '');
    const person = updatesById[attendeeId];
    if (!person) return;
    const rowNum = idx + 2;
    updateRowFromObject_(rosterSheet, rowNum, {
      lodging_preference: person.lodgingPreference || '',
      lodging_option_key: person.lodgingOptionKey || '',
      lodging_option_label: person.lodgingOptionLabel || '',
      attendance_type: person.attendanceType || '',
      program_type: person.programType || '',
      shirt_size: person.shirtSize || '',
      lodging_status: person.lodgingStatus || '',
      bunk_type: person.bunkType || 'none',
      assigned_lodging_area: person.assignedLodgingArea || '',
      notes: person.notes || ''
    });
  });
}

function updateSummaryRowsForRegistration_(ss, assigned) {
  const campSheet = ss.getSheetByName(CONFIG.sheets.campingGroups);
  const assignSheet = ss.getSheetByName(CONFIG.sheets.assignments);

  const adultCount = (assigned.people || []).filter(p => p.ageGroup === 'adult').length;
  const guardianCount = (assigned.people || []).filter(p => p.isGuardian).length;
  const childCount = (assigned.people || []).filter(p => p.ageGroup === 'child').length;

  upsertRegistrationSummaryRow_(campSheet, assigned.registrationId, {
    club_name: assigned.registrationLabel || '',
    total_headcount: (assigned.people || []).length,
    staff_count: adultCount,
    child_count: childCount,
    timestamp: assigned.timestamp || new Date(),
    lodging_preference: assigned.lodgingPreference || '',
    lodging_status: assigned.lodgingStatus || '',
    bunk_type_summary: assigned.bunkTypeSummary || 'none',
    assigned_lodging_area: assigned.assignedLodgingArea || '',
    notes: assigned.notes || '',
    adult_count: adultCount,
    guardian_count: guardianCount
  });

  upsertRegistrationSummaryRow_(assignSheet, assigned.registrationId, {
    club_name: assigned.registrationLabel || '',
    director_email: assigned.registrantEmail || '',
    camping_location: assigned.assignedLodgingArea || '',
    lodging_preference: assigned.lodgingPreference || '',
    lodging_status: assigned.lodgingStatus || '',
    bunk_type_summary: assigned.bunkTypeSummary || 'none',
    assigned_lodging_area: assigned.assignedLodgingArea || '',
    guardian_link_key: assigned.guardianLinkSummary || '',
    notes: assigned.notes || '',
    created_at: assigned.createdAt || assigned.timestamp || new Date()
  });
}

function readPeopleForRegistrationFromRoster_(rosterSheet, registrationId) {
  if (rosterSheet.getLastRow() < 2) return [];
  const rows = rosterSheet.getRange(2, 1, rosterSheet.getLastRow() - 1, rosterSheet.getLastColumn()).getValues();
  const colMap = getColumnMap_(rosterSheet);

  return rows
    .filter(row => String(row[colMap['registration_id']] || '') === registrationId)
    .map(row => {
      const fullName = String(row[colMap['attendee_name']] || '').trim();
      const split = splitName_(fullName);
      const ageGroup = String(row[colMap['age_group']] || '').trim().toLowerCase()
        || (String(row[colMap['role']] || '').trim().toLowerCase() === 'child' ? 'child' : 'adult');
      return {
        id: String(row[colMap['attendee_id']] || ''),
        name: fullName,
        firstName: String(row[colMap['first_name']] || split.firstName || ''),
        lastName: String(row[colMap['last_name']] || split.lastName || ''),
        email: String(row[colMap['email']] || row[colMap['registrant_email']] || ''),
        phone: String(row[colMap['phone']] || ''),
        age: row[colMap['age']] || '',
        ageGroup: ageGroup,
        isMinor: String(row[colMap['is_minor']] || '').toLowerCase() === 'yes',
        gender: String(row[colMap['gender']] || ''),
        isGuardian: String(row[colMap['is_guardian']] || '').toLowerCase() === 'yes',
        guardianName: String(row[colMap['guardian_name']] || ''),
        guardianPhone: String(row[colMap['guardian_phone']] || ''),
        guardianEmail: String(row[colMap['guardian_email']] || ''),
        guardianRelationship: String(row[colMap['guardian_relationship']] || ''),
        guardianRegistrationId: String(row[colMap['guardian_registration_id']] || ''),
        guardianLinkKey: String(row[colMap['guardian_link_key']] || ''),
        ownLinkKey: String(row[colMap['own_link_key']] || ''),
        lodgingPreference: normalizeLodgingPreference_(row[colMap['lodging_preference']] || ''),
        lodgingOptionKey: String(row[colMap['lodging_option_key']] || ''),
        lodgingOptionLabel: String(row[colMap['lodging_option_label']] || ''),
        attendanceType: String(row[colMap['attendance_type']] || ''),
        programType: String(row[colMap['program_type']] || ''),
        shirtSize: String(row[colMap['shirt_size']] || '').toUpperCase(),
        volunteer: String(row[colMap['volunteer']] || 'no').toLowerCase() === 'yes' ? 'yes' : 'no',
        isVolunteer: String(row[colMap['volunteer']] || 'no').toLowerCase() === 'yes',
        priceSelected: row[colMap['price_selected']] || '',
        paymentStatus: String(row[colMap['payment_status']] || ''),
        paymentReference: String(row[colMap['payment_reference']] || ''),
        medicalNotes: String(row[colMap['medical_notes']] || ''),
        specialConsiderations: String(row[colMap['special_considerations']] || ''),
        lodgingStatus: String(row[colMap['lodging_status']] || '').toLowerCase(),
        bunkType: String(row[colMap['bunk_type']] || '').toLowerCase(),
        assignedLodgingArea: String(row[colMap['assigned_lodging_area']] || ''),
        notes: String(row[colMap['notes']] || ''),
        checkInStatus: String(row[colMap['check_in_status']] || '').toLowerCase(),
        checkInTimestamp: row[colMap['check_in_timestamp']] || '',
        role: String(row[colMap['role']] || ''),
        status: String(row[colMap['participation_status']] || '').toLowerCase(),
        dietaryRestrictions: String(row[colMap['dietary_restrictions']] || ''),
        isMedicalPersonnel: String(row[colMap['is_medical_personnel']] || '').toLowerCase() === 'yes',
        isMasterGuideInvestiture: String(row[colMap['is_master_guide_investiture']] || '').toLowerCase() === 'yes',
        isFirstTime: String(row[colMap['is_first_time']] || '').toLowerCase() === 'yes',
        createdAt: row[colMap['created_at']] || row[colMap['timestamp']] || new Date()
      };
    });
}

function resolveGuardianLinkForChild_(ss, child, localAdults) {
  if (!CONFIG.lodging.validation.childTopBunksRequireGuardian) {
    return { isLinked: true, guardian: null, reason: '' };
  }

  if (child.guardianLinkKey) {
    const localGuardian = localAdults.find(person => person.isGuardian && person.ownLinkKey && person.ownLinkKey === child.guardianLinkKey);
    if (localGuardian) {
      return { isLinked: true, guardian: localGuardian, reason: '' };
    }
  }

  if (child.guardianRegistrationId) {
    const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
    if (regSheet) {
      const rowNum = findRegistrationRow_(regSheet, child.guardianRegistrationId);
      if (rowNum > 0) {
        const guardianReg = readRowAsObject_(regSheet, rowNum);
        const isAssigned = String(guardianReg['lodging_status'] || '').toLowerCase() === 'assigned';
        return {
          isLinked: true,
          guardian: isAssigned ? { lodgingStatus: 'assigned', assignedLodgingArea: guardianReg['assigned_lodging_area'] || '' } : { lodgingStatus: 'waitlist' },
          reason: ''
        };
      }
    }
    return { isLinked: false, guardian: null, reason: 'Guardian registration reference not found.' };
  }

  return { isLinked: false, guardian: null, reason: 'Child is missing a guardian link and cannot be auto-assigned a cabin bunk.' };
}

function buildAssignedRegistration_(registrationData, people, lodgingPreference, explicitStatus) {
  const assignedArea = registrationData.assignedLodgingArea || people.find(p => p.assignedLodgingArea)?.assignedLodgingArea || '';
  return Object.assign({}, registrationData, {
    lodgingPreference: lodgingPreference,
    lodgingStatus: explicitStatus || deriveRegistrationLodgingStatus_(people),
    bunkTypeSummary: deriveBunkTypeSummary_(people),
    assignedLodgingArea: assignedArea,
    people: people,
    roster: people,
    guardianLinkSummary: people.map(p => p.guardianLinkKey).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ')
  });
}

function setAssignmentOnPerson_(person, assignment) {
  person.lodgingStatus = assignment.lodgingStatus;
  person.bunkType = assignment.bunkType;
  person.assignedLodgingArea = assignment.assignedLodgingArea;
  person.consumesPublicInventory = !!assignment.consumesPublicInventory;
  person.inventoryCategory = assignment.inventoryCategory || '';
  person.assignmentReason = assignment.assignmentReason || '';
}

function buildInventorySummaryRow_(definition, stats) {
  return {
    lodging_category: definition.key,
    label: definition.label,
    inventory_type: definition.inventoryType,
    public_capacity: definition.isUnlimited ? '' : definition.publicCapacity,
    assigned_public_units: stats.assignedPublicUnits,
    assigned_top_bunks: stats.assignedTopBunks,
    waitlist_count: stats.waitlistCount,
    manual_review_count: stats.manualReviewCount,
    remaining_public_capacity: stats.remainingPublicCapacity,
    is_unlimited: definition.isUnlimited ? 'Yes' : 'No',
    last_recalculated_at: stats.lastRecalculatedAt,
    notes: stats.notes || ''
  };
}

function deleteRowsByRegistrationId_(sheet, registrationId) {
  if (!sheet || sheet.getLastRow() < 2) return;
  const colNum = getColumnNumber_(sheet, 'registration_id');
  if (colNum < 1) return;
  const ids = sheet.getRange(2, colNum, sheet.getLastRow() - 1, 1).getValues().flat();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i] || '') === registrationId) sheet.deleteRow(i + 2);
  }
}

function upsertRegistrationSummaryRow_(sheet, registrationId, values) {
  if (!sheet) return;
  const rowNum = findRegistrationSummaryRow_(sheet, registrationId);
  if (rowNum > 0) {
    updateRowFromObject_(sheet, rowNum, Object.assign({ registration_id: registrationId }, values));
  } else {
    appendRowFromObject_(sheet, Object.assign({ registration_id: registrationId }, values));
  }
}

function findRegistrationSummaryRow_(sheet, registrationId) {
  if (!sheet || sheet.getLastRow() < 2) return -1;
  const colNum = getColumnNumber_(sheet, 'registration_id');
  if (colNum < 1) return -1;
  const ids = sheet.getRange(2, colNum, sheet.getLastRow() - 1, 1).getValues().flat();
  const idx = ids.indexOf(String(registrationId));
  return idx >= 0 ? idx + 2 : -1;
}

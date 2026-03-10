// ============================================================
// Man Camp Registration System
// Google Apps Script — Inventory.gs
// Centralized public availability and inventory counting helpers.
// ============================================================

function getAvailability() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lodging = calculateRemainingInventory(ss).byCategory;
  const shirts = calculateRemainingShirtInventory_(ss);
  const options = getRegistrationOptionDefinitions_().map(option => {
    const lodgingStats = lodging[option.inventoryCategory] || {};
    const remaining = option.countsAsUnlimited
      ? 'Unlimited'
      : (typeof lodgingStats.remainingPublicCapacity === 'number' ? lodgingStats.remainingPublicCapacity : option.publicCapacity || 0);
    const soldOut = !option.countsAsUnlimited && Number(remaining) <= 0;
    return {
      optionKey: option.key,
      optionLabel: option.label,
      attendanceType: option.attendanceType,
      lodgingType: option.lodgingType,
      price: option.price,
      available: remaining,
      soldOut: soldOut,
      waitlistAllowed: !!option.waitlistAllowed,
      statusLabel: soldOut && option.waitlistAllowed ? 'Waitlist' : (soldOut ? 'Sold Out' : 'Available')
    };
  });

  return {
    success: true,
    options: options,
    shirts: shirts,
    timestamp: new Date().toISOString()
  };
}

function getRegistrationOptionDefinitions_() {
  return Object.keys(CONFIG.registrationOptions).map(key => {
    const option = CONFIG.registrationOptions[key];
    const lodgingDefinition = getLodgingDefinitionByPreference_(option.inventoryCategory);
    return Object.assign({}, option, {
      publicCapacity: lodgingDefinition ? lodgingDefinition.publicCapacity : '',
      isUnlimited: lodgingDefinition ? lodgingDefinition.isUnlimited : !!option.countsAsUnlimited
    });
  });
}

function getRegistrationOptionByKey_(optionKey) {
  const normalized = normalizeLodgingPreference_(optionKey);
  const match = getRegistrationOptionDefinitions_().find(option => option.key === normalized);
  return match || null;
}

function calculateRemainingShirtInventory_(ss, excludeRegistrationId) {
  const remaining = {};
  Object.keys(CONFIG.shirts.sizes).forEach(size => {
    remaining[size] = {
      size: size,
      capacity: Number(CONFIG.shirts.sizes[size]) || 0,
      assigned: 0,
      remaining: Number(CONFIG.shirts.sizes[size]) || 0,
      soldOut: false
    };
  });

  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!rosterSheet || rosterSheet.getLastRow() < 2) {
    return remaining;
  }

  const rows = rosterSheet.getRange(2, 1, rosterSheet.getLastRow() - 1, rosterSheet.getLastColumn()).getValues();
  const colMap = getColumnMap_(rosterSheet);

  rows.forEach(row => {
    const registrationId = String(row[colMap['registration_id']] || '');
    if (excludeRegistrationId && registrationId === excludeRegistrationId) return;

    const shirtSize = String(row[colMap['shirt_size']] || '').trim().toUpperCase();
    if (!shirtSize || !remaining[shirtSize]) return;

    const status = String(row[colMap['lodging_status']] || '').trim().toLowerCase();
    const ACTIVE_STATUSES = ['assigned', 'waitlisted', 'waitlist', 'manual_review'];
    if (!ACTIVE_STATUSES.includes(status)) return;

    remaining[shirtSize].assigned++;
    remaining[shirtSize].remaining = Math.max(0, remaining[shirtSize].capacity - remaining[shirtSize].assigned);
    remaining[shirtSize].soldOut = remaining[shirtSize].remaining <= 0;
  });

  return remaining;
}

function checkInventoryAvailability_(ss, normalized, excludeRegistrationId) {
  const result = {
    valid: true,
    option: null,
    shirt: null,
    messages: []
  };

  const option = getRegistrationOptionByKey_(normalized.lodgingOptionKey || normalized.lodgingPreference || '');
  if (!option) {
    result.valid = false;
    result.messages.push('Unknown registration option.');
    return result;
  }

  result.option = option;

  if (!option.countsAsUnlimited) {
    const lodging = calculateRemainingInventory(ss, excludeRegistrationId).byCategory[option.inventoryCategory];
    const remaining = lodging && typeof lodging.remainingPublicCapacity === 'number'
      ? lodging.remainingPublicCapacity
      : 0;
    if (remaining <= 0) {
      result.valid = false;
      result.messages.push(option.label + ' is sold out.');
    }
  }

  const shirtSize = String(normalized.shirtSize || '').trim().toUpperCase();
  if (shirtSize) {
    const shirts = calculateRemainingShirtInventory_(ss, excludeRegistrationId);
    const shirt = shirts[shirtSize];
    result.shirt = shirt || null;
    if (!shirt) {
      result.valid = false;
      result.messages.push('Unknown shirt size selected.');
    } else if (shirt.remaining <= 0) {
      result.valid = false;
      result.messages.push('Shirt size ' + shirtSize + ' is sold out.');
    }
  }

  return result;
}

function seedShirtInventorySheet_(sheet) {
  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    : [];
  const existingMap = new Map(existing.map((row, idx) => [String(row[0] || '').trim().toUpperCase(), idx + 2]));

  Object.keys(CONFIG.shirts.sizes).forEach(size => {
    const rowObj = {
      shirt_size: size,
      starting_inventory: Number(CONFIG.shirts.sizes[size]) || 0,
      assigned_count: 0,
      remaining_inventory: Number(CONFIG.shirts.sizes[size]) || 0,
      sold_out: 'No',
      last_recalculated_at: '',
      notes: ''
    };
    if (existingMap.has(size)) {
      updateRowFromObject_(sheet, existingMap.get(size), {
        shirt_size: rowObj.shirt_size,
        starting_inventory: rowObj.starting_inventory
      });
    } else {
      appendRowFromObject_(sheet, rowObj);
    }
  });
}

function refreshShirtInventorySheet_(ss) {
  const sheet = ss.getSheetByName(CONFIG.sheets.shirtInventory);
  if (!sheet) return;

  seedShirtInventorySheet_(sheet);
  const inventory = calculateRemainingShirtInventory_(ss);
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    : [];

  rows.forEach((row, idx) => {
    const size = String(row[0] || '').trim().toUpperCase();
    const stats = inventory[size];
    if (!stats) return;
    updateRowFromObject_(sheet, idx + 2, {
      shirt_size: stats.size,
      starting_inventory: stats.capacity,
      assigned_count: stats.assigned,
      remaining_inventory: stats.remaining,
      sold_out: stats.soldOut ? 'Yes' : 'No',
      last_recalculated_at: new Date()
    });
  });
}

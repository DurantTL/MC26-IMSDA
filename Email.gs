// ============================================================
// Man Camp Registration System
// Google Apps Script — Email.gs
// Man Camp registration confirmation email generation and sending.
// ============================================================

// ============================================================
// SECTION 1 — SEND
// ============================================================

/**
 * Sends the HTML confirmation email to the primary registrant.
 *
 * @param {Object} data
 */
function sendConfirmationEmail_(data) {
  const emailData = normalizeConfirmationEmailData_(data);
  const html = buildConfirmationEmailHtml_(emailData);
  const subjectTarget = emailData.registrationLabel || emailData.registrantName || 'Your Registration';
  const subject = CONFIG.email.subject + ' — ' + subjectTarget;

  GmailApp.sendEmail(
    emailData.registrantEmail,
    subject,
    'Please view this message in an HTML-capable email client.',
    {
      htmlBody: html,
      name: CONFIG.email.fromName,
      replyTo: CONFIG.email.replyTo
    }
  );
}


// ============================================================
// SECTION 2 — DATA NORMALIZATION
// ============================================================

/**
 * Rebuilds a confirmation-email payload from stored sheet data.
 * Used by resend flows and background jobs so they match the new model.
 *
 * @param {Spreadsheet} ss
 * @param {string} registrationId
 * @returns {Object}
 */
function buildConfirmationEmailDataFromRegistration_(ss, registrationId) {
  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!regSheet || !rosterSheet) throw new Error('Required sheets not found.');

  const rowNum = findRegistrationRow_(regSheet, registrationId);
  if (rowNum < 0) throw new Error('Registration not found: ' + registrationId);

  const reg = readRowAsObject_(regSheet, rowNum);
  const roster = readPeopleForRegistrationFromRoster_(rosterSheet, registrationId);

  return normalizeConfirmationEmailData_({
    registrationId: registrationId,
    registrationLabel: reg['registration_label'] || reg['club_name'] || reg['registrant_name'] || 'Registration',
    registrantName: [reg['first_name'] || '', reg['last_name'] || ''].join(' ').trim() || reg['registrant_name'] || '',
    registrantEmail: reg['email'] || reg['registrant_email'] || '',
    registrantPhone: reg['phone'] || reg['registrant_phone'] || '',
    timestamp: reg['timestamp'] || new Date(),
    lodgingPreference: reg['lodging_preference'] || '',
    lodgingOptionLabel: reg['lodging_option_label'] || '',
    attendanceType: reg['attendance_type'] || '',
    programType: reg['program_type'] || '',
    shirtSize: reg['shirt_size'] || '',
    paymentStatus: reg['payment_status'] || '',
    paymentReference: reg['payment_reference'] || '',
    lodgingStatus: reg['lodging_status'] || '',
    assignedLodgingArea: reg['assigned_lodging_area'] || reg['camping_location'] || '',
    notes: reg['notes'] || '',
    roster: roster,
    people: roster,
    costBreakdown: reg['estimated_total'] !== ''
      ? {
          estimatedTotal: Number(reg['estimated_total']) || 0,
          paymentStatus: String(reg['payment_status'] || '').toLowerCase(),
          amountPaid: Number(reg['amount_paid']) || 0,
          optionPrice: Number(reg['option_price']) || 0
        }
      : {}
  });
}

/**
 * Produces a stable Man Camp confirmation-email payload from either:
 * - current runtime registration objects, or
 * - legacy mixed payloads used by older resend/background paths.
 *
 * @param {Object} data
 * @returns {Object}
 */
function normalizeConfirmationEmailData_(data) {
  const peopleInput = data.people || data.roster || [];
  const normalizedPeople = peopleInput.map(function(person, index) {
    const fullName = String(person.name || person.attendee_name || person.full_name || person.attendeeName || '').trim();
    const split = splitName_(fullName);
    const ageGroup = String(person.ageGroup || person.age_group || '').trim().toLowerCase()
      || (String(person.role || '').toLowerCase() === 'child' ? 'child' : 'adult');
    const isGuardian = person.isGuardian !== undefined
      ? toBoolean_(person.isGuardian)
      : String(person.is_guardian || '').toLowerCase() === 'yes';
    const lodgingPreference = normalizeEmailPreference_(person.lodgingPreference || person.lodging_preference || data.lodgingPreference || '');
    const lodgingStatus = normalizeEmailStatus_(person.lodgingStatus || person.lodging_status || data.lodgingStatus || '');
    const bunkType = normalizeEmailBunkType_(person.bunkType || person.bunk_type || defaultBunkTypeForPreference_(lodgingPreference, lodgingStatus));
    const guardianLinkKey = String(person.guardianLinkKey || person.guardian_link_key || '').trim();
    const guardianRegistrationId = String(person.guardianRegistrationId || person.guardian_registration_id || '').trim();

    return {
      id: String(person.id || person.attendeeId || person.attendee_id || 'ATT-' + String(index + 1).padStart(3, '0')),
      name: fullName || [person.firstName || person.first_name || split.firstName, person.lastName || person.last_name || split.lastName].join(' ').trim() || 'Attendee',
      firstName: String(person.firstName || person.first_name || split.firstName || ''),
      lastName: String(person.lastName || person.last_name || split.lastName || ''),
      age: person.age || '',
      ageGroup: ageGroup,
      isGuardian: isGuardian,
      guardianLinkKey: guardianLinkKey,
      guardianRegistrationId: guardianRegistrationId,
      lodgingPreference: lodgingPreference,
      lodgingStatus: lodgingStatus,
      bunkType: bunkType,
      assignedLodgingArea: String(person.assignedLodgingArea || person.assigned_lodging_area || '').trim(),
      notes: String(person.notes || '').trim(),
      dietaryRestrictions: String(person.dietaryRestrictions || person.dietary_restrictions || '').trim(),
      assignmentReason: String(person.assignmentReason || person.assignment_reason || '').trim()
    };
  });

  const derivedStatus = normalizedPeople.length ? deriveRegistrationLodgingStatus_(normalizedPeople) : normalizeEmailStatus_(data.lodgingStatus || '');
  const registrationLabel = String(data.registrationLabel || data.clubName || data.club_name || deriveRegistrationLabel_({
    lastName: normalizedPeople[0] ? normalizedPeople[0].lastName : '',
    fullName: data.registrantName || (normalizedPeople[0] ? normalizedPeople[0].name : '')
  }, data)).trim();

  return {
    registrationId: String(data.registrationId || data.registration_id || '').trim(),
    registrationLabel: registrationLabel || 'Registration',
    registrantName: String(data.registrantName || data.registrant_name || '').trim() || (normalizedPeople[0] ? normalizedPeople[0].name : 'Registrant'),
    registrantEmail: String(data.registrantEmail || data.registrant_email || data.email || '').trim(),
    registrantPhone: String(data.registrantPhone || data.registrant_phone || data.phone || '').trim(),
    timestamp: data.timestamp || data.createdAt || data.created_at || new Date(),
    lodgingPreference: normalizeEmailPreference_(data.lodgingPreference || data.lodging_preference || (normalizedPeople[0] ? normalizedPeople[0].lodgingPreference : '')),
    lodgingOptionLabel: String(data.lodgingOptionLabel || data.lodging_option_label || '').trim(),
    attendanceType: String(data.attendanceType || data.attendance_type || '').trim(),
    programType: String(data.programType || data.program_type || '').trim(),
    shirtSize: String(data.shirtSize || data.shirt_size || '').trim().toUpperCase(),
    paymentStatus: String(data.paymentStatus || data.payment_status || '').trim(),
    paymentReference: String(data.paymentReference || data.payment_reference || '').trim(),
    lodgingStatus: normalizeEmailStatus_(data.lodgingStatus || data.lodging_status || derivedStatus),
    assignedLodgingArea: String(data.assignedLodgingArea || data.assigned_lodging_area || '').trim(),
    notes: String(data.notes || '').trim(),
    people: normalizedPeople,
    roster: normalizedPeople,
    costBreakdown: data.costBreakdown || {},
    guardLinkSummary: normalizedPeople.map(function(person) { return person.guardianLinkKey; }).filter(Boolean).filter(function(value, index, arr) {
      return arr.indexOf(value) === index;
    }).join(', ')
  };
}

function normalizeEmailPreference_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CONFIG.lodging.validation.validPreferences.includes(normalized) ? normalized : '';
}

function normalizeEmailStatus_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CONFIG.lodging.validation.validStatuses.includes(normalized) ? normalized : 'pending';
}

function normalizeEmailBunkType_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CONFIG.lodging.validation.validBunkTypes.includes(normalized) ? normalized : 'none';
}


// ============================================================
// SECTION 3 — HTML BUILDER
// ============================================================

function buildConfirmationEmailHtml_(data) {
  const people = data.people || [];
  const statusBadge = buildEmailStatusBadge_(data.lodgingStatus);
  const assignedCount = people.filter(function(person) { return person.lodgingStatus === 'assigned'; }).length;
  const waitlistCount = people.filter(function(person) { return person.lodgingStatus === 'waitlist'; }).length;
  const reviewCount = people.filter(function(person) { return person.lodgingStatus === 'manual_review'; }).length;
  const guardianCount = people.filter(function(person) { return person.isGuardian; }).length;
  const childCount = people.filter(function(person) { return person.ageGroup === 'child'; }).length;
  const createdAt = data.timestamp ? formatEmailDateTime_(data.timestamp) : 'Pending';
  const estimatedTotal = typeof data.costBreakdown.estimatedTotal === 'number' && !isNaN(data.costBreakdown.estimatedTotal)
    ? formatCurrency_(data.costBreakdown.estimatedTotal)
    : '';
  const amountPaid = typeof data.costBreakdown.amountPaid === 'number' && !isNaN(data.costBreakdown.amountPaid)
    ? formatCurrency_(data.costBreakdown.amountPaid)
    : '';
  const needsAttention = waitlistCount > 0 || reviewCount > 0;

  const peopleRows = people.map(function(person) {
    const guardianLine = buildGuardianRelationshipLine_(person, people);
    const notesLine = person.notes
      ? '<div style="margin-top:4px;color:#8a5300;font-size:11px;">Notes: ' + escapeHtml_(person.notes) + '</div>'
      : '';
    const dietaryLine = person.dietaryRestrictions
      ? '<div style="margin-top:4px;color:#8a5300;font-size:11px;">Dietary: ' + escapeHtml_(person.dietaryRestrictions) + '</div>'
      : '';
    const reasonLine = (person.lodgingStatus === 'waitlist' || person.lodgingStatus === 'manual_review') && person.assignmentReason
      ? '<div style="margin-top:4px;color:#6b7280;font-size:11px;">' + escapeHtml_(person.assignmentReason) + '</div>'
      : '';

    return '' +
      '<tr>' +
        '<td style="' + tdValueStyle_() + 'border-bottom:1px solid #e6e1d6;">' +
          '<div style="font-weight:700;color:#24323a;">' + escapeHtml_(person.name) + '</div>' +
          '<div style="margin-top:4px;font-size:11px;color:#6b7280;">' +
            escapeHtml_(buildEmailPersonMeta_(person)) +
          '</div>' +
          guardianLine +
          notesLine +
          dietaryLine +
          reasonLine +
        '</td>' +
        '<td style="' + tdValueStyle_() + 'border-bottom:1px solid #e6e1d6;">' + escapeHtml_(labelForPreference_(person.lodgingPreference) || 'Not selected') + '</td>' +
        '<td style="' + tdValueStyle_() + 'border-bottom:1px solid #e6e1d6;">' + buildEmailStatusBadge_(person.lodgingStatus) + '</td>' +
        '<td style="' + tdValueStyle_() + 'border-bottom:1px solid #e6e1d6;">' +
          escapeHtml_(labelForBunkType_(person.bunkType)) +
          (person.assignedLodgingArea ? '<div style="margin-top:4px;font-size:11px;color:#6b7280;">' + escapeHtml_(person.assignedLodgingArea) + '</div>' : '') +
        '</td>' +
      '</tr>';
  }).join('');

  return (
'<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
  '<meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>' + escapeHtml_(CONFIG.email.subject) + '</title>' +
'</head>' +
'<body style="margin:0;padding:0;background:#f5f1e7;font-family:Arial,Helvetica,sans-serif;color:#24323a;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1e7;padding:20px 0;">' +
    '<tr><td align="center">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #ddd5c5;">' +
        '<tr>' +
          '<td style="background:linear-gradient(135deg,#355c4f 0%,#254237 100%);padding:28px 24px;text-align:center;">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#c8ddd3;">' + escapeHtml_(CONFIG.system.organizationName) + '</div>' +
            '<div style="margin-top:8px;font-size:28px;line-height:1.1;font-weight:700;color:#ffffff;">' + escapeHtml_(CONFIG.email.eventName) + '</div>' +
            '<div style="margin-top:8px;font-size:13px;color:#dce9e2;">' + escapeHtml_(CONFIG.email.eventDates) + ' • ' + escapeHtml_(CONFIG.email.eventLocation) + '</div>' +
          '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="background:#a55a1f;padding:14px 24px;text-align:center;color:#fff;">' +
            '<div style="font-size:15px;font-weight:700;">Registration Received • ' + escapeHtml_(data.registrationId || 'Pending ID') + '</div>' +
          '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="padding:26px 24px;">' +
            '<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">Hello <strong>' + escapeHtml_(data.registrantName || 'Registrant') + '</strong>,</p>' +
            '<p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:#394851;">' +
              'Thank you for registering for <strong>' + escapeHtml_(CONFIG.email.eventName) + '</strong>. ' +
              'This confirmation summarizes the attendees on your registration and the current lodging status. ' +
              '<span style="font-weight:700;">TODO:</span> Update this intro text if you want a different pastoral or ministry tone before launch.' +
            '</p>' +

            '<div style="background:#f8f4eb;border:1px solid #e6dfd2;border-radius:12px;padding:16px 18px;margin-bottom:20px;">' +
              '<div style="font-size:16px;font-weight:700;margin-bottom:10px;">Registration Summary</div>' +
              '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">' +
                '<tr><td style="' + tdLabelStyle_() + '">Registration ID</td><td style="' + tdValueStyle_() + 'font-family:monospace;">' + escapeHtml_(data.registrationId || 'Pending') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Registration Label</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.registrationLabel) + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Submitted</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(createdAt) + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Primary Contact</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.registrantName || '—') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Email</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.registrantEmail || '—') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Phone</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.registrantPhone || '—') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Registration Option</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.lodgingOptionLabel || labelForPreference_(data.lodgingPreference) || '—') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Program</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.programType || 'standard') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Shirt Size</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.shirtSize || '—') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Payment Status</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.paymentStatus || 'pending') + '</td></tr>' +
                '<tr><td style="' + tdLabelStyle_() + '">Payment Reference</td><td style="' + tdValueStyle_() + '">' + escapeHtml_(data.paymentReference || '—') + '</td></tr>' +
              '</table>' +
            '</div>' +

            '<div style="background:#f3f7f5;border:1px solid #d8e4dd;border-radius:12px;padding:16px 18px;margin-bottom:20px;">' +
              '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;">' +
                '<div>' +
                  '<div style="font-size:16px;font-weight:700;">Current Lodging Status</div>' +
                  '<div style="margin-top:6px;color:#53636b;font-size:13px;">Preference: ' + escapeHtml_(labelForPreference_(data.lodgingPreference) || 'Not selected') + '</div>' +
                  (data.assignedLodgingArea ? '<div style="margin-top:4px;color:#53636b;font-size:13px;">Assigned Area: ' + escapeHtml_(data.assignedLodgingArea) + '</div>' : '') +
                '</div>' +
                '<div>' + statusBadge + '</div>' +
              '</div>' +
              (data.notes ? '<div style="margin-top:12px;font-size:13px;color:#53636b;">Notes: ' + escapeHtml_(data.notes) + '</div>' : '') +
            '</div>' +

            '<div style="margin-bottom:20px;">' +
              '<div style="font-size:16px;font-weight:700;margin-bottom:10px;">Party Snapshot</div>' +
              '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">' +
                '<tr>' +
                  buildEmailStatCell_('Attendees', String(people.length), '#f8f4eb') +
                  buildEmailStatCell_('Assigned', String(assignedCount), '#eef7ef') +
                '</tr>' +
                '<tr>' +
                  buildEmailStatCell_('Waitlisted', String(waitlistCount), '#fff5e6') +
                  buildEmailStatCell_('Manual Review', String(reviewCount), '#fdeeee') +
                '</tr>' +
                '<tr>' +
                  buildEmailStatCell_('Guardians', String(guardianCount), '#eef3ff') +
                  buildEmailStatCell_('Children', String(childCount), '#f7efff') +
                '</tr>' +
              '</table>' +
            '</div>' +

            (needsAttention
              ? '<div style="background:#fff6e5;border-left:4px solid #d98a1f;padding:12px 14px;border-radius:6px;margin-bottom:20px;font-size:14px;line-height:1.6;">' +
                  '<strong>Action may still be needed.</strong> Some attendees are currently waitlisted or marked for manual review. ' +
                  'Please keep this email for reference and watch for follow-up from the Man Camp team.' +
                '</div>'
              : '<div style="background:#edf7ef;border-left:4px solid #2e7d32;padding:12px 14px;border-radius:6px;margin-bottom:20px;font-size:14px;line-height:1.6;">' +
                  '<strong>Lodging is currently in good standing.</strong> All attendees on this registration currently have an assigned or standard in-progress lodging outcome.' +
                '</div>') +

            '<div style="font-size:16px;font-weight:700;margin-bottom:10px;">Attendee Details</div>' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6dfd2;border-radius:12px;overflow:hidden;font-size:13px;margin-bottom:20px;">' +
              '<tr style="background:#355c4f;color:#fff;">' +
                '<th style="padding:10px 12px;text-align:left;">Attendee</th>' +
                '<th style="padding:10px 12px;text-align:left;">Preference</th>' +
                '<th style="padding:10px 12px;text-align:left;">Status</th>' +
                '<th style="padding:10px 12px;text-align:left;">Bunk / Area</th>' +
              '</tr>' +
              peopleRows +
            '</table>' +

            ((estimatedTotal || amountPaid)
              ? '<div style="background:#faf7ef;border:1px solid #e6dfd2;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:14px;">' +
                  (estimatedTotal ? '<strong>Selected / Charged Total:</strong> ' + escapeHtml_(estimatedTotal) : '') +
                  (amountPaid ? '<div style="margin-top:6px;"><strong>Amount Paid:</strong> ' + escapeHtml_(amountPaid) + '</div>' : '') +
                  '<div style="margin-top:6px;color:#6b7280;font-size:12px;">This email preserves the selected option and payment reference for Square reconciliation.</div>' +
                '</div>'
              : '') +

            (people.some(function(person) { return person.ageGroup === 'child'; })
              ? '<div style="background:#fff6e5;border-left:4px solid #d98a1f;padding:12px 14px;border-radius:6px;margin-bottom:20px;font-size:14px;line-height:1.6;">' +
                  '<strong>Guardian requirement:</strong> Any minor attending Man Camp must have a guardian at camp at all times.' +
                '</div>'
              : '') +

            '<div style="background:#f8f4eb;border:1px solid #e6dfd2;border-radius:12px;padding:16px 18px;margin-bottom:22px;">' +
              '<div style="font-size:16px;font-weight:700;margin-bottom:8px;">What Happens Next?</div>' +
              '<div style="font-size:14px;line-height:1.7;color:#394851;">' +
                '<div>1. Review the attendee and lodging details above.</div>' +
                '<div>2. If something needs to change, contact the Man Camp team as soon as possible.</div>' +
                '<div>3. If an attendee is waitlisted or under manual review, staff will need to finalize that lodging outcome before arrival.</div>' +
                '<div>4. Bring this registration ID with you to on-site check-in.</div>' +
              '</div>' +
            '</div>' +

            '<div style="background:#f3f7f5;border:1px solid #d8e4dd;border-radius:12px;padding:16px 18px;">' +
              '<div style="font-size:15px;font-weight:700;margin-bottom:6px;">Questions?</div>' +
              '<div style="font-size:14px;line-height:1.7;color:#394851;">' +
                'Contact <strong>' + escapeHtml_(CONFIG.event.contactName) + '</strong><br>' +
                'Email: <a href="mailto:' + escapeHtml_(CONFIG.email.contactEmail) + '" style="color:#355c4f;">' + escapeHtml_(CONFIG.email.contactEmail) + '</a><br>' +
                'Phone: ' + escapeHtml_(CONFIG.email.contactPhone) + '<br>' +
                '<span style="color:#6b7280;font-size:12px;">TODO: Replace the placeholder contact details in Config.gs before production use.</span>' +
              '</div>' +
            '</div>' +
          '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="background:#24323a;padding:18px 24px;text-align:center;color:#d3d8db;font-size:12px;">' +
            escapeHtml_(CONFIG.system.organizationName) + '<br>' +
            'Automated Man Camp registration confirmation • ' + escapeHtml_(data.registrationId || 'Pending') +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</td></tr>' +
  '</table>' +
'</body>' +
'</html>'
  );
}

function buildGuardianRelationshipLine_(person, people) {
  if (person.isGuardian) return '<div style="margin-top:4px;font-size:11px;color:#44606c;">Guardian</div>';
  if (person.ageGroup !== 'child') return '';
  if (person.guardianLinkKey) {
    const guardian = people.find(function(candidate) {
      return candidate.isGuardian && candidate.guardianLinkKey && candidate.guardianLinkKey === person.guardianLinkKey;
    });
    if (guardian) {
      return '<div style="margin-top:4px;font-size:11px;color:#44606c;">Linked to guardian: ' + escapeHtml_(guardian.name) + '</div>';
    }
    return '<div style="margin-top:4px;font-size:11px;color:#8a5300;">Guardian link key: ' + escapeHtml_(person.guardianLinkKey) + '</div>';
  }
  if (person.guardianRegistrationId) {
    return '<div style="margin-top:4px;font-size:11px;color:#44606c;">Linked guardian registration: ' + escapeHtml_(person.guardianRegistrationId) + '</div>';
  }
  return '<div style="margin-top:4px;font-size:11px;color:#8d1025;">No guardian link on file</div>';
}

function buildEmailPersonMeta_(person) {
  return [
    person.id,
    person.age !== '' ? 'Age ' + person.age : '',
    person.ageGroup === 'child' ? 'Child' : 'Adult',
    person.isGuardian ? 'Guardian' : ''
  ].filter(Boolean).join(' • ');
}

function buildEmailStatusBadge_(status) {
  const normalized = normalizeEmailStatus_(status);
  const styles = {
    assigned: 'background:#e6f4ea;color:#1d5d27;border:1px solid #c8e6cf;',
    waitlist: 'background:#fff3e0;color:#8a5300;border:1px solid #f1d4a8;',
    pending: 'background:#eef3ff;color:#294f87;border:1px solid #d3dcf6;',
    manual_review: 'background:#fdeeee;color:#8d1025;border:1px solid #f3c6ce;'
  };
  return '<span style="display:inline-block;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:700;' + styles[normalized] + '">' +
    escapeHtml_(labelForStatus_(normalized)) + '</span>';
}

function buildEmailStatCell_(label, value, bg) {
  return '<td style="padding:4px;" width="50%">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + bg + ';border:1px solid #e1d8c8;border-radius:10px;font-size:13px;">' +
      '<tr><td style="padding:10px 12px;">' +
        '<div style="font-size:19px;font-weight:700;line-height:1.1;">' + escapeHtml_(value) + '</div>' +
        '<div style="margin-top:4px;font-size:11px;color:#6b7280;">' + escapeHtml_(label) + '</div>' +
      '</td></tr>' +
    '</table>' +
  '</td>';
}

function labelForPreference_(value) {
  const labels = {
    shared_cabin_detached: 'Shared Cabin - Detached restroom/shower, bring your own linens',
    shared_cabin_connected: 'Shared Cabin - Connected restroom, linens provided',
    rv_hookups: 'RV Camping - with hookups',
    tent_no_hookups: 'Tent Camping - no hookups',
    sabbath_attendance_only: 'Sabbath Attendance only'
  };
  return labels[String(value || '').trim().toLowerCase()] || '';
}

function labelForStatus_(value) {
  const labels = {
    assigned: 'Assigned',
    waitlist: 'Waitlisted',
    pending: 'Pending',
    manual_review: 'Manual Review'
  };
  return labels[String(value || '').trim().toLowerCase()] || 'Pending';
}

function labelForBunkType_(value) {
  const labels = {
    bottom: 'Bottom Bunk',
    top_guardian_child: 'Top Bunk (Guardian-Linked Child)',
    rv: 'RV Spot',
    tent: 'Tent',
    day_only: 'Sabbath Attendance only',
    none: 'None'
  };
  return labels[String(value || '').trim().toLowerCase()] || 'None';
}

function formatEmailDateTime_(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}


// ============================================================
// SECTION 4 — INLINE STYLE HELPERS
// ============================================================

function tdLabelStyle_() {
  return 'padding:6px 0;color:#6b7280;font-size:12px;vertical-align:top;width:38%;';
}

function tdValueStyle_() {
  return 'padding:6px 0;color:#24323a;font-size:13px;vertical-align:top;';
}

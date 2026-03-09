// ============================================================
// Man Camp Registration System
// Google Apps Script — Config.gs
// All system-wide configuration lives here.
// ============================================================

const CONFIG = {
  system: {
    appName:          'Man Camp Registration System',
    menuTitle:        '🏕️ Man Camp System',
    adminPanelTitle:  '🏕️ Man Camp Admin Panel',
    adminPanelSub:    'Man Camp · Configuration Placeholder',
    healthCheckName:  'Man Camp Registration System',
    organizationName: 'TODO: Set conference / ministry name',
    registrationLabel: 'registration',
    attendeeGroupLabel: 'group',
    contactLabel:     'Primary Contact',
  },

  event: {
    // TODO: Replace these placeholders with the actual event details before production use.
    code:        'man-camp',
    year:        '2026',
    name:        '2026 Man Camp',
    tagline:     'TODO: Set Man Camp theme / subtitle',
    dates:       'TODO: Set Man Camp dates',
    location:    'TODO: Set Man Camp location',
    contactName: 'TODO: Set Man Camp contact name',
  },

  sheets: {
    raw:           'RAW',
    registrations: 'Registrations',
    roster:        'Roster',
    campingGroups: 'CampingGroups',
    assignments:   'Assignments',
    lodgingInventory: 'LodgingInventory',
    lodgingAssignments: 'LodgingAssignments',
    emailLog:      'EmailLog'
  },

  email: {
    enabled:       true,
    // TODO: Replace placeholder sender/contact values before going live.
    fromName:      'TODO: Set sender display name',
    fromEmail:     'TODO: Set sender email address',
    replyTo:       'TODO: Set reply-to email address',
    subject:       'Man Camp Registration Received',
    eventName:     '2026 Man Camp',
    eventDates:    'TODO: Set Man Camp dates',
    eventLocation: 'TODO: Set Man Camp location',
    contactEmail:  'TODO: Set contact email',
    contactPhone:  'TODO: Set contact phone'
  },

  pdf: {
    folderName:           'Man Camp Registration PDFs',
    batchDialogLabel:     'Man Camp registration PDFs',
    batchCompleteSubject: 'Man Camp PDF Generation Complete',
  },

  lodging: {
    categories: {
      cabinNoBath: {
        key:                'cabin_no_bath',
        label:              'Cabin without connected bathroom',
        inventoryType:      'bottom_bunk',
        publicCapacity:     90,
        countsAsUnlimited:  false,
      },
      cabinBath: {
        key:                'cabin_bath',
        label:              'Cabin with connected bathroom',
        inventoryType:      'bottom_bunk',
        publicCapacity:     33,
        countsAsUnlimited:  false,
      },
      rv: {
        key:                'rv',
        label:              'RV spot (water/electric only)',
        inventoryType:      'rv_spot',
        publicCapacity:     0,
        countsAsUnlimited:  false,
      },
      tent: {
        key:                'tent',
        label:              'Tent',
        inventoryType:      'tent',
        publicCapacity:     0,
        countsAsUnlimited:  true,
      }
    },
    capacities: {
      cabinNoBathBottomBunks: 90,
      cabinBathBottomBunks:   33,
      rvSpots:                0,
      tentUnlimited:          true,
    },
    validation: {
      onlyBottomBunksCountTowardPublicCapacity: true,
      childTopBunksRequireGuardian:             true,
      childWithoutGuardianGetsAutoBunk:         false,
      waitlistWhenBottomBunksExhausted:         true,
      adultsConsumeBottomBunkInventory:         true,
      guardiansConsumeBottomBunkInventory:      true,
      validStatuses: ['assigned', 'waitlist', 'pending', 'manual_review'],
      validBunkTypes: ['bottom', 'top_guardian_child', 'rv', 'tent', 'none'],
      validPreferences: ['cabin_no_bath', 'cabin_bath', 'rv', 'tent'],
    },
    inventoryAudit: {
      inventorySummaryRowOrder: ['cabin_no_bath', 'cabin_bath', 'rv', 'tent'],
    },
  },

  pricing: {
    baseRate:          9,   // $ per person
    lateFee:           5,   // $ per person after early bird deadline
    mealDiscount:      5,   // $ off per person served (meal_count = number of people being fed)
    earlyBirdDeadline: new Date('2026-04-10T23:59:59')
  },

  attendeeLabels: {
    adult:    'Adult',
    child:    'Child',
    guardian: 'Guardian'
  },

  colors: {
    headerBg:   '#1a3a5c',
    headerFg:   '#ffffff',
    accentBg:   '#2e6da4',
    accentFg:   '#ffffff',
    firstTimer: '#fff2cc',
    dietary:    '#fce5cd',
    sectionBg:  '#d9e8f7'
  }
};

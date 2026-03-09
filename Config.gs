// ============================================================
// Man Camp Registration System
// Google Apps Script — Config.gs
// Centralized event, pricing, inventory, and validation rules.
// ============================================================

const CONFIG = {
  system: {
    appName: 'Man Camp Registration System',
    menuTitle: '🏕️ Man Camp System',
    adminPanelTitle: '🏕️ Man Camp Admin Panel',
    adminPanelSub: 'Man Camp 2026 · Shields of Faith',
    healthCheckName: 'Man Camp Registration System',
    organizationName: 'Iowa-Missouri Conference of Seventh-day Adventists',
    registrationLabel: 'registration',
    attendeeGroupLabel: 'party',
    contactLabel: 'Registrant'
  },

  event: {
    code: 'man-camp',
    year: '2026',
    name: 'Man Camp 2026',
    theme: 'Shields of Faith',
    themeReference: 'Ephesians 6:16',
    tagline: 'Shields of Faith · Ephesians 6:16',
    dates: 'TODO: Set Man Camp 2026 dates',
    location: 'Camp Heritage',
    contactName: 'TODO: Set Man Camp contact name',
    speakers: [
      'Lee Rochholz — Iowa Missouri Conference President',
      'Mike Fenton — Senior Pastor, Chapel Oaks Seventh-day Adventist Church'
    ]
  },

  sheets: {
    raw: 'RAW',
    registrations: 'Registrations',
    roster: 'Roster',
    campingGroups: 'CampingGroups',
    assignments: 'Assignments',
    lodgingInventory: 'LodgingInventory',
    lodgingAssignments: 'LodgingAssignments',
    shirtInventory: 'ShirtInventory',
    emailLog: 'EmailLog'
  },

  email: {
    enabled: true,
    fromName: 'TODO: Set sender display name',
    fromEmail: 'TODO: Set sender email address',
    replyTo: 'TODO: Set reply-to email address',
    subject: 'Man Camp 2026 Registration Received',
    eventName: 'Man Camp 2026',
    eventDates: 'TODO: Set Man Camp 2026 dates',
    eventLocation: 'Camp Heritage',
    contactEmail: 'TODO: Set contact email',
    contactPhone: 'TODO: Set contact phone'
  },

  pdf: {
    folderName: 'Man Camp Registration PDFs',
    batchDialogLabel: 'Man Camp registration PDFs',
    batchCompleteSubject: 'Man Camp PDF Generation Complete'
  },

  registrationOptions: {
    shared_cabin_connected: {
      key: 'shared_cabin_connected',
      label: 'Shared Cabin - Connected restroom, linens provided',
      description: 'Shared cabin with connected restroom. Linens provided.',
      price: 120,
      attendanceType: 'overnight',
      lodgingType: 'cabin',
      inventoryCategory: 'shared_cabin_connected',
      countsAsUnlimited: false,
      waitlistAllowed: true
    },
    shared_cabin_detached: {
      key: 'shared_cabin_detached',
      label: 'Shared Cabin - Detached restroom/shower, bring your own linens',
      description: 'Shared cabin with detached restroom and shower. Bring your own linens.',
      price: 100,
      attendanceType: 'overnight',
      lodgingType: 'cabin',
      inventoryCategory: 'shared_cabin_detached',
      countsAsUnlimited: false,
      waitlistAllowed: true
    },
    rv_hookups: {
      key: 'rv_hookups',
      label: 'RV Camping - with hookups',
      description: 'RV camping with hookups.',
      price: 90,
      attendanceType: 'overnight',
      lodgingType: 'rv',
      inventoryCategory: 'rv_hookups',
      countsAsUnlimited: false,
      waitlistAllowed: true
    },
    tent_no_hookups: {
      key: 'tent_no_hookups',
      label: 'Tent Camping - no hookups',
      description: 'Tent camping with no hookups.',
      price: 80,
      attendanceType: 'overnight',
      lodgingType: 'tent',
      inventoryCategory: 'tent_no_hookups',
      countsAsUnlimited: true,
      waitlistAllowed: false
    },
    sabbath_attendance_only: {
      key: 'sabbath_attendance_only',
      label: 'Sabbath Attendance only',
      description: 'Sabbath attendance only. No overnight lodging inventory used.',
      price: 70,
      attendanceType: 'sabbath_only',
      lodgingType: 'none',
      inventoryCategory: 'sabbath_attendance_only',
      countsAsUnlimited: true,
      waitlistAllowed: false
    }
  },

  lodging: {
    categories: {
      sharedCabinConnected: {
        key: 'shared_cabin_connected',
        label: 'Shared Cabin - Connected restroom, linens provided',
        inventoryType: 'bottom_bunk',
        publicCapacity: 33,
        countsAsUnlimited: false
      },
      sharedCabinDetached: {
        key: 'shared_cabin_detached',
        label: 'Shared Cabin - Detached restroom/shower, bring your own linens',
        inventoryType: 'bottom_bunk',
        publicCapacity: 90,
        countsAsUnlimited: false
      },
      rvHookups: {
        key: 'rv_hookups',
        label: 'RV Camping - with hookups',
        inventoryType: 'rv_spot',
        publicCapacity: 0,
        countsAsUnlimited: false
      },
      tentNoHookups: {
        key: 'tent_no_hookups',
        label: 'Tent Camping - no hookups',
        inventoryType: 'tent',
        publicCapacity: '',
        countsAsUnlimited: true
      },
      sabbathOnly: {
        key: 'sabbath_attendance_only',
        label: 'Sabbath Attendance only',
        inventoryType: 'day_attendance',
        publicCapacity: '',
        countsAsUnlimited: true
      }
    },
    capacities: {
      sharedCabinConnectedBottomBunks: 33,
      sharedCabinDetachedBottomBunks: 90,
      rvHookupSpots: 0,
      tentUnlimited: true,
      sabbathOnlyUnlimited: true
    },
    validation: {
      onlyBottomBunksCountTowardPublicCapacity: true,
      childTopBunksRequireGuardian: true,
      childWithoutGuardianGetsAutoBunk: false,
      waitlistWhenBottomBunksExhausted: true,
      adultsConsumeBottomBunkInventory: true,
      guardiansConsumeBottomBunkInventory: true,
      validStatuses: ['assigned', 'waitlist', 'pending', 'manual_review'],
      validBunkTypes: ['bottom', 'top_guardian_child', 'rv', 'tent', 'day_only', 'none'],
      validPreferences: ['shared_cabin_connected', 'shared_cabin_detached', 'rv_hookups', 'tent_no_hookups', 'sabbath_attendance_only']
    },
    inventoryAudit: {
      inventorySummaryRowOrder: ['shared_cabin_connected', 'shared_cabin_detached', 'rv_hookups', 'tent_no_hookups', 'sabbath_attendance_only']
    }
  },

  shirts: {
    sizes: {
      M: 20,
      L: 35,
      XL: 31,
      '2XL': 5,
      '3XL': 5,
      '4XL': 4
    },
    waitlistOnSellout: false
  },

  programs: {
    standard: {
      key: 'standard',
      label: 'Standard'
    },
    youngMens: {
      key: 'young_mens',
      label: "Young Men's program",
      minAge: 10,
      maxAge: 14
    }
  },

  ageRules: {
    minorMaxAge: 17,
    adultMinAge: 18
  },

  payments: {
    acceptedStatuses: ['paid', 'completed', 'authorized', 'pending', 'unpaid', 'failed'],
    defaultMethod: 'square_via_fluent_forms'
  },

  attendeeLabels: {
    adult: 'Adult',
    child: 'Child',
    guardian: 'Guardian',
    minor: 'Minor'
  },

  colors: {
    headerBg: '#1a3a5c',
    headerFg: '#ffffff',
    accentBg: '#2e6da4',
    accentFg: '#ffffff',
    firstTimer: '#fff2cc',
    dietary: '#fce5cd',
    sectionBg: '#d9e8f7'
  }
};

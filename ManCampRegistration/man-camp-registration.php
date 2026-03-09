<?php
/**
 * Plugin Name: Man Camp Registration
 * Plugin URI:  https://imsda.org
 * Description: Bridges Fluent Forms Man Camp registration submissions to the
 *              Google Apps Script backend and provides the Man Camp attendee widget.
 * Version:     2.1.0
 * Author:      Iowa-Missouri Conference of Seventh-day Adventists
 * Author URI:  https://imsda.org
 * License:     GPL-2.0+
 * Text Domain: man-camp-registration
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// ============================================================
// SECTION 1 — SETTINGS HELPERS
// ============================================================

define( 'MANCAMP_OPTION_GROUP', 'mancamp_settings' );
define( 'MANCAMP_HTTP_TIMEOUT', 30 );

function mancamp_get_setting( $key, $default = '' ) {
    $options = get_option( MANCAMP_OPTION_GROUP, [] );
    return isset( $options[ $key ] ) ? $options[ $key ] : $default;
}

function mancamp_gas_url()   { return mancamp_get_setting( 'gas_url',    '' ); }
function mancamp_form_id()   { return (int) mancamp_get_setting( 'form_id',   0 ); }
function mancamp_page_slug() { return mancamp_get_setting( 'page_slug',  'man-camp-registration' ); }
function mancamp_debug()     { return (bool) mancamp_get_setting( 'debug_mode', false ); }


// ============================================================
// SECTION 2 — FIELD MAP
// ============================================================

const MANCAMP_FIELD_MAP = [
    'first_name'              => 'first_name',
    'last_name'               => 'last_name',
    'email'                   => 'email',
    'phone'                   => 'phone',
    'age'                     => 'age',
    'age_group'               => 'age_group',
    'is_minor'                => 'is_minor',
    'is_guardian'             => 'is_guardian',
    'guardian_name'           => 'guardian_name',
    'guardian_phone'          => 'guardian_phone',
    'guardian_email'          => 'guardian_email',
    'guardian_relationship'   => 'guardian_relationship',
    'guardian_link_key'       => 'guardian_link_key',
    'guardian_registration_id'=> 'guardian_registration_id',
    'guardian_name_reference' => 'guardian_name_reference',
    'program_type'            => 'program_type',
    'shirt_size'              => 'shirt_size',
    'lodging_preference'      => 'lodging_preference',
    'lodging_option_key'      => 'lodging_option_key',
    'lodging_option_label'    => 'lodging_option_label',
    'attendance_type'         => 'attendance_type',
    'price_selected'          => 'price_selected',
    'payment_status'          => 'payment_status',
    'payment_reference'       => 'payment_reference',
    'payment_method'          => 'payment_method',
    'frontend_total'          => 'frontend_total',
    'square_total'            => 'square_total',
    'amount_paid'             => 'amount_paid',
    'medical_notes'           => 'medical_notes',
    'special_considerations'  => 'special_considerations',
    'lodging_status'          => 'lodging_status',
    'bunk_type'               => 'bunk_type',
    'assigned_lodging_area'   => 'assigned_lodging_area',
    'notes'                   => 'notes',
    'attendee_count'          => 'attendeeCount',
];

const MANCAMP_BOOLEAN_FIELDS = [
    'is_minor',
    'is_guardian',
];

const MANCAMP_VALID_AGE_GROUPS = [
    'adult',
    'child',
];

const MANCAMP_VALID_LODGING_PREFERENCES = [
    'shared_cabin_connected',
    'shared_cabin_detached',
    'rv_hookups',
    'tent_no_hookups',
    'sabbath_attendance_only',
];

const MANCAMP_VALID_LODGING_STATUSES = [
    'assigned',
    'waitlist',
    'pending',
    'manual_review',
];

const MANCAMP_VALID_BUNK_TYPES = [
    'bottom',
    'top_guardian_child',
    'rv',
    'tent',
    'day_only',
    'none',
];


// ============================================================
// SECTION 3 — HOOKS
// ============================================================

add_action( 'plugins_loaded', 'mancamp_register_hooks' );

function mancamp_register_hooks() {
    add_action( 'wp_enqueue_scripts', 'mancamp_enqueue_scripts' );
    add_action( 'wp_head',            'mancamp_add_notranslate_meta' );
    add_action( 'admin_menu',         'mancamp_admin_menu' );
    add_action( 'admin_post_mancamp_save_settings',  'mancamp_save_settings' );
    add_action( 'admin_post_mancamp_retry',          'mancamp_handle_retry' );
    add_action( 'admin_post_mancamp_manual_resync',  'mancamp_handle_manual_resync' );
    add_action( 'fluentform_submission_inserted',     'mancamp_handle_submission', 20, 3 );
}


// ============================================================
// SECTION 4 — SCRIPT ENQUEUE
// ============================================================

function mancamp_enqueue_scripts() {
    if ( ! mancamp_is_registration_page() ) return;

    $js_file = plugin_dir_path( __FILE__ ) . 'man-camp-registration.js';
    $version = file_exists( $js_file ) ? filemtime( $js_file ) : '2.0.0';

    wp_enqueue_script(
        'man-camp-registration',
        plugin_dir_url( __FILE__ ) . 'man-camp-registration.js',
        [],
        $version,
        true
    );

    wp_localize_script( 'man-camp-registration', 'manCampRegistrationSettings', [
        'gasUrl' => mancamp_gas_url(),
        'fieldMapTodo' => [
            'lodging_option_key' => 'TODO: confirm Fluent Forms option field name/value mapping in production',
            'shirt_size' => 'TODO: confirm Fluent Forms shirt field name/value mapping in production',
            'price_selected' => 'TODO: confirm the pricing field feeding Square remains in submission payload'
        ]
    ] );
}

function mancamp_is_registration_page() {
    $slug = mancamp_page_slug();
    if ( empty( $slug ) ) return false;
    if ( is_page( $slug ) ) return true;
    $current = trim( parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH ), '/' );
    return ( $current === $slug || substr( $current, -strlen( $slug ) ) === $slug );
}


// ============================================================
// SECTION 5 — NOTRANSLATE META TAG
// ============================================================

function mancamp_add_notranslate_meta() {
    if ( ! mancamp_is_registration_page() ) return;
    // Protect hidden JSON fields from translation, not the whole page.
    ?>
    <script>
    document.addEventListener('DOMContentLoaded', function () {
        const selector = [
          'input[name="people_json"]',
          'input[data-name="people_json"]',
          'input[name="roster_json"]',
          'input[data-name="roster_json"]'
        ].join(', ');
        const applyNoTranslate = () => {
            document.querySelectorAll(selector).forEach((field) => {
                field.setAttribute('translate', 'no');
                field.classList.add('notranslate');
            });
        };
        applyNoTranslate(); // Run on load
        document.addEventListener('fluentform_step_changed', applyNoTranslate);
    });
    </script>
    <?php
}


// ============================================================
// SECTION 6 — SUBMISSION HANDLER
// ============================================================

function mancamp_handle_submission( $insertId, $formData, $form ) {
    if ( (int) $form->id !== mancamp_form_id() ) return;

    mancamp_log( 'Submission received. FF entry ID: ' . $insertId );

    $payload = mancamp_build_payload( $formData, $insertId );

    if ( is_wp_error( $payload ) ) {
        mancamp_log( 'Payload build error: ' . $payload->get_error_message(), 'error' );
        return;
    }

    $result = mancamp_post_to_gas( $payload );

    if ( is_wp_error( $result ) ) {
        mancamp_log( 'GAS POST error: ' . $result->get_error_message(), 'error' );
        mancamp_store_failed_payload( $insertId, $payload, $result->get_error_message() );
        return;
    }

    mancamp_log( 'GAS response: ' . wp_json_encode( $result ) );

    if ( ! empty( $result['registrationId'] ) ) {
        $log   = get_option( 'mancamp_id_log', [] );
        $log[] = [
            'ff_entry_id'     => $insertId,
            'registration_id' => $result['registrationId'],
            'timestamp'       => current_time( 'mysql' ),
        ];
        if ( count( $log ) > 500 ) $log = array_slice( $log, -500 );
        update_option( 'mancamp_id_log', $log, false );
    }
}


// ============================================================
// SECTION 7 — PAYLOAD BUILDER
// ============================================================

function mancamp_build_payload( $formData, $insertId ) {
    $payload = [
        'action'            => 'submitRegistration',
        'fluentFormEntryId' => (string) $insertId,
        'submittedAt'       => current_time( 'c' ),
    ];

    foreach ( MANCAMP_FIELD_MAP as $ff_key => $gas_key ) {
        if ( in_array( $ff_key, [ 'attendee_count' ], true ) ) continue;
        if ( ! isset( $formData[ $ff_key ] ) ) continue;

        $raw = $formData[ $ff_key ];
        $payload[ $gas_key ] = mancamp_sanitise_top_level_field( $ff_key, $raw );
    }

    $payment_meta = mancamp_collect_payment_meta( $formData );
    foreach ( $payment_meta as $key => $value ) {
        if ( $value === '' || $value === null ) continue;
        $payload[ $key ] = $value;
    }

    $people = mancamp_extract_people_payload( $formData );
    if ( is_wp_error( $people ) ) {
        return $people;
    }

    $primary = $people[0];
    $payload['first_name'] = $payload['first_name'] ?? $primary['first_name'];
    $payload['last_name']  = $payload['last_name']  ?? $primary['last_name'];
    $payload['email']      = $payload['email']      ?? $primary['email'];
    $payload['phone']      = $payload['phone']      ?? $primary['phone'];
    $payload['notes']      = $payload['notes']      ?? '';

    if ( empty( $payload['lodging_preference'] ) ) {
        $payload['lodging_preference'] = $primary['lodging_preference'];
    }

    if ( empty( $payload['lodging_option_key'] ) ) {
        $payload['lodging_option_key'] = $payload['lodging_preference'];
    }

    $full_name = trim( $payload['first_name'] . ' ' . $payload['last_name'] );
    $payload['registrantName']  = $full_name;
    $payload['registrantEmail'] = $payload['email'];
    $payload['registrantPhone'] = $payload['phone'];
    $payload['registrationLabel'] = $full_name !== '' ? $full_name : 'Man Camp Registration';
    $payload['people'] = $people;
    $payload['roster'] = $people; // Legacy alias for existing GAS parsing paths.
    $payload['attendeeCount'] = ! empty( $formData['attendee_count'] )
        ? (int) $formData['attendee_count']
        : count( $people );

    return $payload;
}


// ============================================================
// SECTION 8 — ATTENDEE SANITISERS
// ============================================================

function mancamp_extract_people_payload( $formData ) {
    $people_raw = $formData['people_json'] ?? $formData['roster_json'] ?? '';

    if ( $people_raw !== '' ) {
        $decoded = json_decode( wp_unslash( $people_raw ), true );
        if ( json_last_error() !== JSON_ERROR_NONE || ! is_array( $decoded ) ) {
            return new WP_Error( 'invalid_people_json', 'Could not decode people_json: ' . json_last_error_msg() );
        }

        return mancamp_sanitise_people( $decoded, $formData );
    }

    $fallback_person = mancamp_build_single_person_from_fields( $formData );
    if ( empty( $fallback_person ) ) {
        return new WP_Error( 'empty_people', 'No attendee data was submitted.' );
    }

    return [ $fallback_person ];
}

function mancamp_sanitise_people( $people, $formData = [] ) {
    $clean = [];
    $default_lodging = mancamp_normalise_lodging_preference( $formData['lodging_preference'] ?? '' );
    $default_option_key = mancamp_normalise_lodging_preference( $formData['lodging_option_key'] ?? $default_lodging );
    $default_option_label = sanitize_text_field( $formData['lodging_option_label'] ?? '' );
    $default_program = sanitize_text_field( $formData['program_type'] ?? 'standard' );
    $default_shirt = strtoupper( sanitize_text_field( $formData['shirt_size'] ?? '' ) );

    foreach ( $people as $idx => $raw ) {
        if ( ! is_array( $raw ) ) {
            continue;
        }

        $age = is_numeric( $raw['age'] ?? null ) ? (int) $raw['age'] : ( is_numeric( $formData['age'] ?? null ) ? (int) $formData['age'] : '' );
        $first_name = sanitize_text_field( $raw['first_name'] ?? $raw['firstName'] ?? '' );
        $last_name  = sanitize_text_field( $raw['last_name'] ?? $raw['lastName'] ?? '' );
        $email      = mancamp_sanitise_email( $raw['email'] ?? '' );
        $phone      = sanitize_text_field( $raw['phone'] ?? '' );
        $notes      = sanitize_textarea_field( $raw['notes'] ?? '' );
        $age_group  = mancamp_normalise_age_group( $raw['age_group'] ?? $raw['ageGroup'] ?? '', $age );
        $is_minor = mancamp_to_bool( $raw['is_minor'] ?? ( $age !== '' ? $age < 18 : $age_group === 'child' ) );
        $is_guardian = mancamp_to_bool( $raw['is_guardian'] ?? $raw['isGuardian'] ?? false );
        $guardian_name = sanitize_text_field( $raw['guardian_name'] ?? $raw['guardianName'] ?? $formData['guardian_name'] ?? '' );
        $guardian_phone = sanitize_text_field( $raw['guardian_phone'] ?? $raw['guardianPhone'] ?? $formData['guardian_phone'] ?? '' );
        $guardian_email = mancamp_sanitise_email( $raw['guardian_email'] ?? $raw['guardianEmail'] ?? $formData['guardian_email'] ?? '' );
        $guardian_relationship = sanitize_text_field( $raw['guardian_relationship'] ?? $raw['guardianRelationship'] ?? $formData['guardian_relationship'] ?? '' );
        $guardian_link_key = sanitize_text_field( $raw['guardian_link_key'] ?? $raw['guardianLinkKey'] ?? '' );
        $guardian_registration_id = sanitize_text_field( $raw['guardian_registration_id'] ?? $raw['guardianRegistrationId'] ?? '' );
        $guardian_name_reference = sanitize_text_field( $raw['guardian_name_reference'] ?? $raw['guardianNameReference'] ?? '' );
        $lodging_preference = mancamp_normalise_lodging_preference(
            $raw['lodging_preference'] ?? $raw['lodgingPreference'] ?? $default_lodging
        );
        $lodging_option_key = mancamp_normalise_lodging_preference(
            $raw['lodging_option_key'] ?? $raw['lodgingOptionKey'] ?? $default_option_key
        );
        $lodging_status = mancamp_normalise_enum(
            $raw['lodging_status'] ?? $raw['lodgingStatus'] ?? '',
            MANCAMP_VALID_LODGING_STATUSES
        );
        $bunk_type = mancamp_normalise_enum(
            $raw['bunk_type'] ?? $raw['bunkType'] ?? '',
            MANCAMP_VALID_BUNK_TYPES
        );

        if ( $first_name === '' && $last_name === '' && $email === '' && $phone === '' ) {
            continue;
        }

        if ( $first_name === '' || $last_name === '' ) {
            return new WP_Error(
                'missing_person_name',
                'Each attendee must include both first and last name. Problem found at attendee #' . ( $idx + 1 ) . '.'
            );
        }

        $person = [
            'id'                       => sanitize_text_field( $raw['id'] ?? '' ),
            'first_name'               => $first_name,
            'last_name'                => $last_name,
            'email'                    => $email,
            'phone'                    => $phone,
            'age_group'                => $age_group,
            'age'                      => $age,
            'is_minor'                 => $is_minor,
            'is_guardian'              => $is_guardian,
            'guardian_name'            => $guardian_name,
            'guardian_phone'           => $guardian_phone,
            'guardian_email'           => $guardian_email,
            'guardian_relationship'    => $guardian_relationship,
            'guardian_link_key'        => $guardian_link_key,
            'guardian_registration_id' => $guardian_registration_id,
            'guardian_name_reference'  => $guardian_name_reference,
            'lodging_preference'       => $lodging_preference,
            'lodging_option_key'       => $lodging_option_key,
            'lodging_option_label'     => sanitize_text_field( $raw['lodging_option_label'] ?? $raw['lodgingOptionLabel'] ?? $default_option_label ),
            'attendance_type'          => sanitize_text_field( $raw['attendance_type'] ?? $raw['attendanceType'] ?? $formData['attendance_type'] ?? '' ),
            'program_type'             => sanitize_text_field( $raw['program_type'] ?? $raw['programType'] ?? $default_program ),
            'shirt_size'               => strtoupper( sanitize_text_field( $raw['shirt_size'] ?? $raw['shirtSize'] ?? $default_shirt ) ),
            'price_selected'           => is_numeric( $raw['price_selected'] ?? null ) ? (float) $raw['price_selected'] : ( is_numeric( $formData['price_selected'] ?? null ) ? (float) $formData['price_selected'] : '' ),
            'payment_status'           => sanitize_text_field( $raw['payment_status'] ?? $raw['paymentStatus'] ?? $formData['payment_status'] ?? '' ),
            'payment_reference'        => sanitize_text_field( $raw['payment_reference'] ?? $raw['paymentReference'] ?? $formData['payment_reference'] ?? '' ),
            'medical_notes'            => sanitize_textarea_field( $raw['medical_notes'] ?? $raw['medicalNotes'] ?? $formData['medical_notes'] ?? '' ),
            'special_considerations'   => sanitize_textarea_field( $raw['special_considerations'] ?? $raw['specialConsiderations'] ?? $formData['special_considerations'] ?? '' ),
            'lodging_status'           => $lodging_status !== '' ? $lodging_status : 'pending',
            'bunk_type'                => $bunk_type !== '' ? $bunk_type : 'none',
            'assigned_lodging_area'    => sanitize_text_field( $raw['assigned_lodging_area'] ?? $raw['assignedLodgingArea'] ?? '' ),
            'notes'                    => $notes,
            'created_at'               => current_time( 'c' ),
        ];

        if ( $person['id'] === '' ) {
            $person['id'] = 'PERS-' . str_pad( (string) ( $idx + 1 ), 3, '0', STR_PAD_LEFT );
        }

        $clean[] = $person;
    }

    if ( empty( $clean ) ) {
        return new WP_Error( 'empty_people', 'At least one attendee is required.' );
    }

    return $clean;
}

function mancamp_build_single_person_from_fields( $formData ) {
    $first_name = sanitize_text_field( $formData['first_name'] ?? '' );
    $last_name  = sanitize_text_field( $formData['last_name'] ?? '' );
    $email      = mancamp_sanitise_email( $formData['email'] ?? '' );
    $phone      = sanitize_text_field( $formData['phone'] ?? '' );

    if ( $first_name === '' && $last_name === '' && $email === '' && $phone === '' ) {
        return [];
    }

    return [
        'id'                       => 'PERS-001',
        'first_name'               => $first_name,
        'last_name'                => $last_name,
        'email'                    => $email,
        'phone'                    => $phone,
        'age'                      => is_numeric( $formData['age'] ?? null ) ? (int) $formData['age'] : '',
        'age_group'                => mancamp_normalise_age_group( $formData['age_group'] ?? '', null ),
        'is_minor'                 => mancamp_to_bool( $formData['is_minor'] ?? false ),
        'is_guardian'              => mancamp_to_bool( $formData['is_guardian'] ?? true ),
        'guardian_name'            => sanitize_text_field( $formData['guardian_name'] ?? '' ),
        'guardian_phone'           => sanitize_text_field( $formData['guardian_phone'] ?? '' ),
        'guardian_email'           => mancamp_sanitise_email( $formData['guardian_email'] ?? '' ),
        'guardian_relationship'    => sanitize_text_field( $formData['guardian_relationship'] ?? '' ),
        'guardian_link_key'        => sanitize_text_field( $formData['guardian_link_key'] ?? '' ),
        'guardian_registration_id' => sanitize_text_field( $formData['guardian_registration_id'] ?? '' ),
        'guardian_name_reference'  => sanitize_text_field( $formData['guardian_name_reference'] ?? '' ),
        'lodging_preference'       => mancamp_normalise_lodging_preference( $formData['lodging_preference'] ?? '' ),
        'lodging_option_key'       => mancamp_normalise_lodging_preference( $formData['lodging_option_key'] ?? $formData['lodging_preference'] ?? '' ),
        'lodging_option_label'     => sanitize_text_field( $formData['lodging_option_label'] ?? '' ),
        'attendance_type'          => sanitize_text_field( $formData['attendance_type'] ?? '' ),
        'program_type'             => sanitize_text_field( $formData['program_type'] ?? 'standard' ),
        'shirt_size'               => strtoupper( sanitize_text_field( $formData['shirt_size'] ?? '' ) ),
        'price_selected'           => is_numeric( $formData['price_selected'] ?? null ) ? (float) $formData['price_selected'] : '',
        'payment_status'           => sanitize_text_field( $formData['payment_status'] ?? '' ),
        'payment_reference'        => sanitize_text_field( $formData['payment_reference'] ?? '' ),
        'medical_notes'            => sanitize_textarea_field( $formData['medical_notes'] ?? '' ),
        'special_considerations'   => sanitize_textarea_field( $formData['special_considerations'] ?? '' ),
        'lodging_status'           => mancamp_normalise_enum( $formData['lodging_status'] ?? '', MANCAMP_VALID_LODGING_STATUSES ) ?: 'pending',
        'bunk_type'                => mancamp_normalise_enum( $formData['bunk_type'] ?? '', MANCAMP_VALID_BUNK_TYPES ) ?: 'none',
        'assigned_lodging_area'    => sanitize_text_field( $formData['assigned_lodging_area'] ?? '' ),
        'notes'                    => sanitize_textarea_field( $formData['notes'] ?? '' ),
        'created_at'               => current_time( 'c' ),
    ];
}

function mancamp_sanitise_top_level_field( $field_key, $raw ) {
    if ( is_array( $raw ) ) {
        $raw = implode( ', ', array_map( 'sanitize_text_field', $raw ) );
    }

    if ( in_array( $field_key, MANCAMP_BOOLEAN_FIELDS, true ) ) {
        return mancamp_to_bool( $raw );
    }

    if ( $field_key === 'email' ) {
        return mancamp_sanitise_email( $raw );
    }

    if ( in_array( $field_key, [ 'age', 'price_selected', 'frontend_total', 'square_total', 'amount_paid' ], true ) ) {
        return is_numeric( $raw ) ? 0 + $raw : '';
    }

    if ( $field_key === 'age_group' ) {
        return mancamp_normalise_age_group( $raw, null );
    }

    if ( $field_key === 'lodging_preference' ) {
        return mancamp_normalise_lodging_preference( $raw );
    }

    if ( $field_key === 'lodging_option_key' ) {
        return mancamp_normalise_lodging_preference( $raw );
    }

    if ( $field_key === 'lodging_status' ) {
        return mancamp_normalise_enum( $raw, MANCAMP_VALID_LODGING_STATUSES );
    }

    if ( $field_key === 'bunk_type' ) {
        return mancamp_normalise_enum( $raw, MANCAMP_VALID_BUNK_TYPES );
    }

    return $field_key === 'notes'
        ? sanitize_textarea_field( $raw )
        : sanitize_text_field( $raw );
}

function mancamp_sanitise_email( $raw ) {
    $value = sanitize_email( $raw );
    return is_email( $value ) ? $value : '';
}

function mancamp_to_bool( $value ) {
    return filter_var( $value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE ) ?? false;
}

function mancamp_normalise_age_group( $value, $age = null ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    if ( in_array( $normalised, MANCAMP_VALID_AGE_GROUPS, true ) ) {
        return $normalised;
    }

    if ( is_numeric( $age ) && (int) $age < 18 ) {
        return 'child';
    }

    return 'adult';
}

function mancamp_normalise_lodging_preference( $value ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    if ( $normalised === 'cabin_with_bath' ) {
        $normalised = 'shared_cabin_connected';
    } elseif ( $normalised === 'cabin_without_bath' ) {
        $normalised = 'shared_cabin_detached';
    } elseif ( $normalised === 'rv' ) {
        $normalised = 'rv_hookups';
    } elseif ( $normalised === 'tent' ) {
        $normalised = 'tent_no_hookups';
    } elseif ( $normalised === 'sabbath_only' ) {
        $normalised = 'sabbath_attendance_only';
    }

    if ( in_array( $normalised, MANCAMP_VALID_LODGING_PREFERENCES, true ) ) {
        return $normalised;
    }

    return $normalised;
}

function mancamp_collect_payment_meta( $formData ) {
    $picked = [
        'payment_status' => '',
        'payment_reference' => '',
        'payment_method' => '',
        'frontend_total' => '',
        'square_total' => '',
        'amount_paid' => '',
    ];

    $payment_status = mancamp_pick_field( $formData, [ 'payment_status', 'paymentStatus', 'payment-status', 'payment_status_field', 'payment' ] );
    $payment_reference = mancamp_pick_field( $formData, [ 'payment_reference', 'paymentReference', 'transaction_id', 'transactionId', 'order_id', 'orderId', 'square_payment_id' ] );
    $payment_method = mancamp_pick_field( $formData, [ 'payment_method', 'paymentMethod', 'payment_type' ] );
    $frontend_total = mancamp_pick_field( $formData, [ 'price_selected', 'frontend_total', 'payment_total', 'paymentTotal', 'total', 'amount' ] );
    $square_total = mancamp_pick_field( $formData, [ 'square_total', 'charged_total', 'total_paid', 'amount_paid' ] );
    $amount_paid = mancamp_pick_field( $formData, [ 'amount_paid', 'total_paid', 'payment_total', 'paymentTotal', 'square_total' ] );

    $picked['payment_status'] = sanitize_text_field( $payment_status );
    $picked['payment_reference'] = sanitize_text_field( $payment_reference );
    $picked['payment_method'] = sanitize_text_field( $payment_method );
    $picked['frontend_total'] = is_numeric( $frontend_total ) ? (float) $frontend_total : '';
    $picked['square_total'] = is_numeric( $square_total ) ? (float) $square_total : '';
    $picked['amount_paid'] = is_numeric( $amount_paid ) ? (float) $amount_paid : '';

    return $picked;
}

function mancamp_pick_field( $formData, $names, $default = '' ) {
    foreach ( $names as $name ) {
        if ( isset( $formData[ $name ] ) && $formData[ $name ] !== '' ) {
            return $formData[ $name ];
        }
        $alt_name = str_replace( [ '-', ' ' ], '_', strtolower( $name ) );
        if ( isset( $formData[ $alt_name ] ) && $formData[ $alt_name ] !== '' ) {
            return $formData[ $alt_name ];
        }
    }
    return $default;
}

function mancamp_normalise_enum( $value, $valid_values ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    return in_array( $normalised, $valid_values, true ) ? $normalised : '';
}


// ============================================================
// SECTION 9 — GAS HTTP POST
// ============================================================

function mancamp_post_to_gas( $payload ) {
    $url = mancamp_gas_url();
    if ( empty( $url ) ) {
        return new WP_Error( 'no_gas_url', 'GAS URL not configured. Go to Settings -> Man Camp Registration.' );
    }

    $body = wp_json_encode( $payload );
    if ( $body === false ) {
        return new WP_Error( 'json_encode_failed', 'Could not JSON-encode payload.' );
    }

    $request_args = [
        'method'      => 'POST',
        'timeout'     => MANCAMP_HTTP_TIMEOUT,
        'redirection' => 0,   // Do NOT auto-follow — GAS issues a 302 that wp_remote_post
                              // would follow with GET, silently dropping the POST body.
        'httpversion' => '1.1',
        'headers'     => [
            'Content-Type' => 'application/json; charset=utf-8',
            'Accept'       => 'application/json',
        ],
        'body'      => $body,
        'sslverify' => true,
    ];

    $response = wp_remote_post( $url, $request_args );

    if ( is_wp_error( $response ) ) return $response;

    $http_code = wp_remote_retrieve_response_code( $response );
    mancamp_log( 'GAS initial HTTP ' . $http_code );

    // GAS web apps issue a 302 redirect on POST.  The redirect destination is
    // typically script.googleusercontent.com/macros/echo?... — an echo endpoint
    // that returns the pre-computed script result via GET.  Re-issuing POST to
    // that URL returns HTTP 405.  Fix: follow 302/301/303 redirects with GET when
    // the Location is cross-domain (echo URL); keep POST for same-domain redirects
    // (auth hops on script.google.com) and always for 307/308.  Also handle up to
    // 5 hops in case there are multiple auth redirects before the echo URL.
    $max_hops = 5;
    $hop      = 0;
    while ( $hop < $max_hops && in_array( $http_code, [ 301, 302, 303, 307, 308 ], true ) ) {
        $hop++;
        $location = wp_remote_retrieve_header( $response, 'location' );
        if ( empty( $location ) ) {
            return new WP_Error( 'gas_redirect_no_location', 'GAS redirected but returned no Location header.' );
        }
        mancamp_log( 'GAS redirect ' . $http_code . ' (hop ' . $hop . ') → ' . $location );

        // 307/308 must maintain POST.
        // 301/302/303: keep POST only for same-domain (script.google.com) auth hops;
        // use GET for cross-domain redirects (e.g. script.googleusercontent.com echo URL).
        $use_post = in_array( $http_code, [ 307, 308 ], true )
                    || (bool) preg_match( '#^https://script\.google\.com#i', $location );

        if ( $use_post ) {
            $response = wp_remote_post( $location, array_merge( $request_args, [ 'redirection' => 0 ] ) );
        } else {
            $response = wp_remote_get( $location, [
                'timeout'     => MANCAMP_HTTP_TIMEOUT,
                'redirection' => 0,
                'httpversion' => '1.1',
                'headers'     => [ 'Accept' => 'application/json' ],
                'sslverify'   => true,
            ] );
        }

        if ( is_wp_error( $response ) ) return $response;
        $http_code = wp_remote_retrieve_response_code( $response );
        mancamp_log( 'GAS hop ' . $hop . ' HTTP ' . $http_code );

        // Safety net: if POST to redirect returned 405, fall back to GET on same URL.
        if ( $http_code === 405 && $use_post ) {
            mancamp_log( 'GAS 405 on POST — retrying hop ' . $hop . ' with GET: ' . $location );
            $response = wp_remote_get( $location, [
                'timeout'     => MANCAMP_HTTP_TIMEOUT,
                'redirection' => 0,
                'httpversion' => '1.1',
                'headers'     => [ 'Accept' => 'application/json' ],
                'sslverify'   => true,
            ] );
            if ( is_wp_error( $response ) ) return $response;
            $http_code = wp_remote_retrieve_response_code( $response );
            mancamp_log( 'GAS fallback GET HTTP ' . $http_code );
        }
    }

    $response_body = wp_remote_retrieve_body( $response );
    mancamp_log( 'GAS body — ' . substr( $response_body, 0, 500 ) );

    if ( $http_code < 200 || $http_code >= 300 ) {
        return new WP_Error( 'gas_http_error', 'GAS returned HTTP ' . $http_code );
    }

    $decoded = json_decode( $response_body, true );
    if ( json_last_error() !== JSON_ERROR_NONE ) {
        // GAS sometimes wraps the JSON payload — try to extract it with a regex.
        preg_match( '/\{.*\}/s', $response_body, $m );
        if ( ! empty( $m[0] ) ) $decoded = json_decode( $m[0], true );
        if ( json_last_error() !== JSON_ERROR_NONE ) {
            return new WP_Error( 'invalid_gas_response', 'GAS response is not valid JSON. Body: ' . substr( $response_body, 0, 200 ) );
        }
    }

    // Validate the GAS-level success flag
    if ( isset( $decoded['success'] ) && $decoded['success'] === false ) {
        if ( ! empty( $decoded['duplicate'] ) ) {
            mancamp_log( 'GAS duplicate — skipping.' );
            return $decoded;
        }
        return new WP_Error( 'gas_logic_error', 'GAS failure: ' . ( $decoded['error'] ?? 'Unknown' ) );
    }

    // Guard: if we got HTTP 200 but the response looks like the doGet() health-check
    // rather than a real registration response, treat it as a silent failure.
    if ( isset( $decoded['status'] ) && $decoded['status'] === 'ok' && ! isset( $decoded['registrationId'] ) && ! isset( $decoded['success'] ) ) {
        return new WP_Error(
            'gas_got_health_check',
            'GAS returned a health-check response instead of a registration response. ' .
            'The POST may have been silently converted to GET. Check your GAS deployment URL.'
        );
    }

    return $decoded;
}


// ============================================================
// SECTION 10 — FAILURE STORAGE
// ============================================================

function mancamp_store_failed_payload( $insertId, $payload, $error ) {
    $key = 'mancamp_failed_' . $insertId;
    set_transient( $key, [
        'payload'     => $payload,
        'error'       => $error,
        'ff_entry_id' => $insertId,
        'failed_at'   => current_time( 'mysql' ),
    ], 30 * DAY_IN_SECONDS );

    $list   = get_option( 'mancamp_failed_list', [] );
    $list[] = $key;
    update_option( 'mancamp_failed_list', array_unique( $list ), false );
    mancamp_log( 'Failed payload stored: ' . $key, 'error' );
}


// ============================================================
// SECTION 11 — ADMIN MENU & ACTION HANDLERS
// ============================================================

function mancamp_admin_menu() {
    add_submenu_page(
        'options-general.php',
        'Man Camp Registration',
        'Man Camp Registration',
        'manage_options',
        'mancamp-registration',
        'mancamp_admin_page'
    );
}

function mancamp_save_settings() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_save_settings', 'mancamp_settings_nonce' );

    update_option( MANCAMP_OPTION_GROUP, [
        'gas_url'    => esc_url_raw( trim( $_POST['gas_url']   ?? '' ) ),
        'form_id'    => (int) ( $_POST['form_id']   ?? 0 ),
        'page_slug'  => trim( sanitize_text_field( $_POST['page_slug'] ?? '' ), '/' ),
        'debug_mode' => isset( $_POST['debug_mode'] ),
    ] );

    wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&saved=1' ) );
    exit;
}

function mancamp_handle_retry() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_retry', 'mancamp_retry_nonce' );

    $key   = sanitize_text_field( $_POST['mancamp_retry_key'] ?? '' );
    $entry = get_transient( $key );

    if ( $entry && is_array( $entry ) ) {
        $result = mancamp_post_to_gas( $entry['payload'] );
        if ( is_wp_error( $result ) ) {
            wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_failed=' . urlencode( $result->get_error_message() ) ) );
        } else {
            delete_transient( $key );
            $list = array_values( array_filter( get_option( 'mancamp_failed_list', [] ), fn( $k ) => $k !== $key ) );
            update_option( 'mancamp_failed_list', $list, false );
            // GAS returned a duplicate response — registration was already processed on the first attempt.
            if ( ! empty( $result['duplicate'] ) ) {
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_ok=' . urlencode( 'already-processed' ) ) );
            } else {
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_ok=' . urlencode( $result['registrationId'] ?? 'sent' ) ) );
            }
        }
    } else {
        wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_failed=' . urlencode( 'Transient not found or expired.' ) ) );
    }
    exit;
}

function mancamp_handle_manual_resync() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_manual_resync', 'mancamp_manual_nonce' );

    $ff_entry_id = (int) ( $_POST['mancamp_manual_entry_id'] ?? 0 );

    if ( $ff_entry_id > 0 && function_exists( 'wpFluentForm' ) ) {
        try {
            $submission = wpFluentForm()->make( 'FluentForm\App\Models\Submission' )->find( $ff_entry_id );
            if ( $submission ) {
                mancamp_handle_submission( $ff_entry_id, json_decode( $submission->response, true ), (object) [ 'id' => mancamp_form_id() ] );
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_ok=' . $ff_entry_id ) );
                exit;
            }
        } catch ( Exception $e ) {
            wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_failed=' . urlencode( $e->getMessage() ) ) );
            exit;
        }
    }

    wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_failed=' . urlencode( 'Entry not found.' ) ) );
    exit;
}


// ============================================================
// SECTION 12 — ADMIN PAGE RENDER
// ============================================================

function mancamp_admin_page() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );

    $gas_url    = mancamp_gas_url();
    $form_id    = mancamp_form_id();
    $page_slug  = mancamp_page_slug();
    $debug_mode = mancamp_debug();

    $gas_ok  = ! empty( $gas_url );
    $form_ok = $form_id > 0;
    $slug_ok = ! empty( $page_slug );
    $js_ok   = file_exists( plugin_dir_path( __FILE__ ) . 'man-camp-registration.js' );

    $all_pages = get_pages( [ 'post_status' => 'publish', 'number' => 200 ] );

    $ff_forms = [];
    if ( function_exists( 'wpFluentForm' ) ) {
        try {
            $ff_forms = wpFluentForm()->make( 'FluentForm\App\Models\Form' )
                ->select( [ 'id', 'title' ] )->orderBy( 'id', 'asc' )->get()->toArray();
        } catch ( Exception $e ) {}
    }

    $saved       = isset( $_GET['saved'] );
    $retry_ok    = $_GET['retry_ok']      ?? false;
    $retry_fail  = $_GET['retry_failed']  ?? false;
    $resync_ok   = $_GET['resync_ok']     ?? false;
    $resync_fail = $_GET['resync_failed'] ?? false;

    $failed_keys    = get_option( 'mancamp_failed_list', [] );
    $failed_entries = [];
    $expired_keys   = [];

    foreach ( $failed_keys as $k ) {
        $e = get_transient( $k );
        if ( $e ) {
            $failed_entries[ $k ] = $e;
        } else {
            $expired_keys[] = $k;
        }
    }

    if ( ! empty( $expired_keys ) ) {
        $new_failed_keys = array_values( array_diff( $failed_keys, $expired_keys ) );
        update_option( 'mancamp_failed_list', $new_failed_keys, false );
    }

    $log = array_reverse( array_slice( get_option( 'mancamp_id_log', [] ), -20 ) );

    ?>
    <div class="wrap" style="max-width:900px;">
    <h1>Man Camp Registration Settings</h1>

    <?php if ( $saved ) : ?>
      <div class="notice notice-success is-dismissible"><p>✔ Settings saved.</p></div>
    <?php endif; ?>
    <?php if ( $retry_ok ) : ?>
      <?php if ( $retry_ok === 'already-processed' ) : ?>
        <div class="notice notice-success is-dismissible"><p>✔ Already processed — this registration was received by GAS on the original submission. The failed entry has been cleared.</p></div>
      <?php else : ?>
        <div class="notice notice-success is-dismissible"><p>✔ Retry successful — GAS ID: <code><?php echo esc_html( $retry_ok ); ?></code></p></div>
      <?php endif; ?>
    <?php endif; ?>
    <?php if ( $retry_fail ) : ?>
      <div class="notice notice-error is-dismissible"><p>✘ Retry failed: <?php echo esc_html( $retry_fail ); ?></p></div>
    <?php endif; ?>
    <?php if ( $resync_ok ) : ?>
      <div class="notice notice-success is-dismissible"><p>✔ Resync triggered for FF entry #<?php echo esc_html( $resync_ok ); ?>.</p></div>
    <?php endif; ?>
    <?php if ( $resync_fail ) : ?>
      <div class="notice notice-error is-dismissible"><p>✘ Resync failed: <?php echo esc_html( $resync_fail ); ?></p></div>
    <?php endif; ?>


    <!-- ── Settings Form ──────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Connection Settings</h2>
      <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
        <?php wp_nonce_field( 'mancamp_save_settings', 'mancamp_settings_nonce' ); ?>
        <input type="hidden" name="action" value="mancamp_save_settings">
        <table class="form-table" role="presentation">
          <tbody>

            <!-- GAS URL -->
            <tr>
              <th scope="row"><label for="gas_url">GAS Web App URL</label></th>
              <td>
                <input type="url" id="gas_url" name="gas_url"
                  value="<?php echo esc_attr( $gas_url ); ?>"
                  class="regular-text"
                  placeholder="https://script.google.com/macros/s/..."
                  required>
                <p class="description">
                  GAS Editor → Deploy → Manage Deployments → Web App URL.
                  <?php if ( $gas_ok ) : ?>
                    <a href="<?php echo esc_url( $gas_url . '?action=ping' ); ?>" target="_blank" style="margin-left:6px;">
                      Ping GAS ↗
                    </a>
                  <?php endif; ?>
                </p>
              </td>
            </tr>

            <!-- Form ID -->
            <tr>
              <th scope="row"><label for="form_id">Fluent Form ID</label></th>
              <td>
                <input type="number" id="form_id" name="form_id"
                  value="<?php echo esc_attr( $form_id ); ?>"
                  class="small-text" min="1" required>
                <?php if ( ! empty( $ff_forms ) ) : ?>
                <p class="description">
                  Available forms — click to select:&nbsp;
                  <?php foreach ( $ff_forms as $i => $f ) :
                    $comma = $i < count( $ff_forms ) - 1 ? ' &bull; ' : '';
                  ?>
                    <a href="#" onclick="document.getElementById('form_id').value=<?php echo (int) $f['id']; ?>;return false;">
                      <?php echo esc_html( $f['title'] ); ?> (ID&nbsp;<?php echo (int) $f['id']; ?>)
                    </a><?php echo $comma; ?>
                  <?php endforeach; ?>
                </p>
                <?php else : ?>
                <p class="description">Find the ID in Fluent Forms → All Forms → ID column.</p>
                <?php endif; ?>
              </td>
            </tr>

            <!-- Page Slug -->
            <tr>
              <th scope="row"><label for="page_slug">Registration Page Slug</label></th>
              <td>
                <input type="text" id="page_slug" name="page_slug"
                  value="<?php echo esc_attr( $page_slug ); ?>"
                  class="regular-text"
                  placeholder="event/man-camp-registration"
                  required>
                <p class="description">Slug or path of the page where the form lives (for example `event/man-camp-registration`). Case-sensitive.</p>
                <?php if ( ! empty( $all_pages ) ) : ?>
                <p class="description">
                  Pick from your published pages:&nbsp;
                  <select onchange="document.getElementById('page_slug').value=this.value;this.value='';" style="max-width:260px;">
                    <option value="">— select to fill in —</option>
                    <?php foreach ( $all_pages as $p ) : ?>
                      <option value="<?php echo esc_attr( $p->post_name ); ?>">
                        <?php echo esc_html( $p->post_title ); ?> — <?php echo esc_html( $p->post_name ); ?>
                      </option>
                    <?php endforeach; ?>
                  </select>
                </p>
                <?php endif; ?>
              </td>
            </tr>

            <!-- Debug Mode -->
            <tr>
              <th scope="row">Debug Mode</th>
              <td>
                <label>
                  <input type="checkbox" name="debug_mode" value="1" <?php checked( $debug_mode ); ?>>
                  Log debug info to the PHP error log
                </label>
                <?php if ( $debug_mode ) : ?>
                  <p class="description" style="color:#d63638;">⚠ Debug is ON — turn off in production.</p>
                <?php endif; ?>
              </td>
            </tr>

          </tbody>
        </table>
        <?php submit_button( 'Save Settings' ); ?>
      </form>
    </div>


    <!-- ── Status Panel ──────────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Status</h2>
      <table class="widefat" style="max-width:620px;">
        <tbody>
          <?php
          $checks = [
              [ 'GAS URL',     $gas_ok,     $gas_ok   ? 'Configured'                                        : 'Not set — enter URL above' ],
              [ 'Form ID',     $form_ok,    $form_ok  ? 'ID: ' . $form_id                                   : 'Set to 0 — select form above' ],
              [ 'Page Slug',   $slug_ok,    $slug_ok  ? $page_slug                                           : 'Not set' ],
              [ 'People JS',   $js_ok,      $js_ok    ? 'man-camp-registration.js found in plugin folder'          : 'NOT FOUND — upload man-camp-registration.js to the plugin folder' ],
              [ 'Debug Mode',  !$debug_mode, $debug_mode ? 'ON — disable in production'                     : 'OFF' ],
          ];
          foreach ( $checks as [ $label, $ok, $text ] ) : ?>
          <tr>
            <td style="width:130px;"><strong><?php echo esc_html( $label ); ?></strong></td>
            <td>
              <span style="color:<?php echo $ok ? 'green' : '#d63638'; ?>;"><?php echo $ok ? '✔' : '✘'; ?></span>
              <?php echo esc_html( $text ); ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>


    <!-- ── Field Reference ───────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Fluent Forms Field Name Reference <span style="color:#646970;font-size:13px;font-weight:400;">(v2.2.0)</span></h2>
      <p style="color:#646970;font-size:13px;">These are the preferred Fluent Forms field names for the Man Camp form. Use them as the field <strong>Name</strong> values in the form builder.</p>
      <table class="widefat striped" style="font-size:12px;">
        <thead><tr><th>FF Field Name</th><th>GAS Key</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>first_name</code></td>              <td><code>first_name</code></td>              <td>Text</td>     <td>Primary registrant first name</td></tr>
          <tr><td><code>last_name</code></td>               <td><code>last_name</code></td>               <td>Text</td>     <td>Primary registrant last name</td></tr>
          <tr><td><code>email</code></td>                   <td><code>email</code></td>                   <td>Email</td>    <td>Primary contact email</td></tr>
          <tr><td><code>phone</code></td>                   <td><code>phone</code></td>                   <td>Phone</td>    <td>Primary contact phone</td></tr>
          <tr><td><code>age</code></td>                     <td><code>age</code></td>                     <td>Number</td>   <td>Required for minor and Young Men's validation</td></tr>
          <tr><td><code>lodging_option_key</code></td>      <td><code>lodging_option_key</code></td>      <td>Select</td>   <td>`shared_cabin_connected`, `shared_cabin_detached`, `rv_hookups`, `tent_no_hookups`, `sabbath_attendance_only`</td></tr>
          <tr><td><code>lodging_option_label</code></td>    <td><code>lodging_option_label</code></td>    <td>Hidden</td>   <td>Preserve the public option label sent to Square and GAS</td></tr>
          <tr><td><code>price_selected</code></td>          <td><code>price_selected</code></td>          <td>Hidden</td>   <td>Keep explicit for Fluent Forms + Square reconciliation</td></tr>
          <tr><td><code>payment_status</code></td>          <td><code>payment_status</code></td>          <td>Hidden</td>   <td>Capture Square / Fluent Forms payment status when available</td></tr>
          <tr><td><code>payment_reference</code></td>       <td><code>payment_reference</code></td>       <td>Hidden</td>   <td>Square order / transaction reference when available</td></tr>
          <tr><td><code>notes</code></td>                   <td><code>notes</code></td>                   <td>Textarea</td> <td>General registration notes</td></tr>
          <tr><td><code>people_json</code></td>             <td><code>people</code></td>                  <td>Hidden</td>   <td>Preferred attendee JSON field written by the widget</td></tr>
          <tr><td><code>roster_json</code></td>             <td><code>roster</code></td>                  <td>Hidden</td>   <td>Legacy mirror of `people_json` for backward compatibility</td></tr>
          <tr><td><code>attendee_count</code></td>          <td><code>attendeeCount</code></td>           <td>Hidden</td>   <td>Attendee count fallback written by the widget</td></tr>
          <tr><td><code>age_group</code></td>               <td><code>age_group</code></td>               <td>Select</td>   <td>Top-level single-person fallback only</td></tr>
          <tr><td><code>program_type</code></td>            <td><code>program_type</code></td>            <td>Select</td>   <td>`standard` or `young_mens`</td></tr>
          <tr><td><code>shirt_size</code></td>              <td><code>shirt_size</code></td>              <td>Select</td>   <td>Inventory-tracked shirt size</td></tr>
          <tr><td><code>guardian_name</code></td>           <td><code>guardian_name</code></td>           <td>Text</td>     <td>Required for minors</td></tr>
          <tr><td><code>guardian_phone</code></td>          <td><code>guardian_phone</code></td>          <td>Text</td>     <td>Required for minors</td></tr>
          <tr><td><code>guardian_email</code></td>          <td><code>guardian_email</code></td>          <td>Email</td>    <td>Required for minors</td></tr>
          <tr><td><code>guardian_relationship</code></td>   <td><code>guardian_relationship</code></td>   <td>Text</td>     <td>Required for minors</td></tr>
          <tr><td><code>is_guardian</code></td>             <td><code>is_guardian</code></td>             <td>Checkbox</td> <td>Top-level single-person fallback only</td></tr>
          <tr><td><code>guardian_link_key</code></td>       <td><code>guardian_link_key</code></td>       <td>Text</td>     <td>Top-level single-person fallback only</td></tr>
          <tr><td><code>guardian_registration_id</code></td><td><code>guardian_registration_id</code></td><td>Text</td>     <td>Top-level single-person fallback only</td></tr>
          <tr><td><code>guardian_name_reference</code></td> <td><code>guardian_name_reference</code></td> <td>Text</td>     <td>Top-level single-person fallback only</td></tr>
        </tbody>
      </table>
      <p style="color:#646970;font-size:12px;margin-top:10px;">TODO: match these field names to the actual Fluent Forms field names used on the production Man Camp form.</p>
    </div>


    <!-- ── Manual Resync ─────────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Manual Resync</h2>
      <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
        <?php wp_nonce_field( 'mancamp_manual_resync', 'mancamp_manual_nonce' ); ?>
        <input type="hidden" name="action" value="mancamp_manual_resync">
        <p>
          <label for="ff_entry_id"><strong>Fluent Forms Entry ID:</strong></label><br>
          <input type="number" id="ff_entry_id" name="mancamp_manual_entry_id" min="1" style="width:140px;" required>
          <button type="submit" class="button button-primary" style="margin-left:8px;">Re-send to GAS</button>
        </p>
        <p style="color:#646970;font-size:12px;">
          Re-sends a specific submission to GAS. GAS will reject it silently if already processed (duplicate guard).
        </p>
      </form>
    </div>


    <!-- ── Failed Submissions ────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">
        Failed Submissions
        <?php if ( ! empty( $failed_entries ) ) : ?>
          <span style="background:#d63638;color:#fff;padding:2px 9px;border-radius:10px;font-size:13px;vertical-align:middle;margin-left:6px;">
            <?php echo count( $failed_entries ); ?>
          </span>
        <?php endif; ?>
      </h2>
      <?php if ( empty( $failed_entries ) ) : ?>
        <p style="color:green;">✔ No failed submissions. All registrations reached GAS.</p>
      <?php else : ?>
        <table class="widefat striped">
          <thead>
            <tr><th>FF Entry</th><th>Registrant</th><th>Email</th><th>Failed At</th><th>Error</th><th></th></tr>
          </thead>
          <tbody>
            <?php foreach ( $failed_entries as $key => $entry ) :
              $p = $entry['payload'] ?? [];
            ?>
            <tr>
              <td><?php echo esc_html( $entry['ff_entry_id'] ?? '—' ); ?></td>
              <td><?php echo esc_html( $p['registrantName']  ?? $p['registrationLabel'] ?? '—' ); ?></td>
              <td><?php echo esc_html( $p['registrantEmail'] ?? $p['email'] ?? '—' ); ?></td>
              <td><?php echo esc_html( $entry['failed_at']   ?? '—' ); ?></td>
              <td style="font-size:12px;max-width:200px;word-break:break-word;"><?php echo esc_html( $entry['error'] ?? '—' ); ?></td>
              <td>
                <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
                  <?php wp_nonce_field( 'mancamp_retry', 'mancamp_retry_nonce' ); ?>
                  <input type="hidden" name="action" value="mancamp_retry">
                  <input type="hidden" name="mancamp_retry_key" value="<?php echo esc_attr( $key ); ?>">
                  <button type="submit" class="button button-small button-primary">Retry</button>
                </form>
              </td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>


    <!-- ── Recent Successes ──────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;">
      <h2 style="margin-top:0;">Recent Successful Registrations <span style="color:#646970;font-size:13px;font-weight:400;">(last 20)</span></h2>
      <?php if ( empty( $log ) ) : ?>
        <p>No registrations logged yet.</p>
      <?php else : ?>
        <table class="widefat striped" style="max-width:700px;">
          <thead><tr><th>FF Entry ID</th><th>GAS Registration ID</th><th>Timestamp</th></tr></thead>
          <tbody>
            <?php foreach ( $log as $entry ) : ?>
            <tr>
              <td><?php echo esc_html( $entry['ff_entry_id']     ?? '—' ); ?></td>
              <td><code><?php echo esc_html( $entry['registration_id'] ?? '—' ); ?></code></td>
              <td><?php echo esc_html( $entry['timestamp']       ?? '—' ); ?></td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>

    </div><!-- /.wrap -->
    <?php
}


// ============================================================
// SECTION 13 — LOGGING
// ============================================================

function mancamp_log( $message, $level = 'info' ) {
    if ( ! mancamp_debug() && $level === 'info' ) return;
    error_log( '[ManCamp][' . strtoupper( $level ) . '] ' . $message );
}


// ============================================================
// SECTION 14 — ACTIVATION / DEACTIVATION
// ============================================================

register_activation_hook( __FILE__, 'mancamp_activate' );

function mancamp_activate() {
    if ( ! function_exists( 'wpFluentForm' ) && ! defined( 'FLUENTFORM' ) ) {
        deactivate_plugins( plugin_basename( __FILE__ ) );
        wp_die( 'Man Camp Registration requires Fluent Forms Pro.', 'Plugin Dependency Error', [ 'back_link' => true ] );
    }
    add_option( MANCAMP_OPTION_GROUP, [
        'gas_url'    => '',
        'form_id'    => 0,
        'page_slug'  => 'man-camp-registration',
        'debug_mode' => false,
    ] );
    add_option( 'mancamp_failed_list', [] );
    add_option( 'mancamp_id_log',      [] );
}

register_deactivation_hook( __FILE__, 'mancamp_deactivate' );

function mancamp_deactivate() {
    // Options and transients preserved intentionally for re-activation
}

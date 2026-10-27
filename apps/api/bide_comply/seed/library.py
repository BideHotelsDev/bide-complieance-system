"""The starter library (PRD §12): David's master register list (BH-CMP-001 §8) and the additions the PRD's review
recommends (§12.2). Every template is labelled "review before use" (CMS-09); David, or a competent person he
appoints, reviews and owns them. Thresholds are starting values from current guidance and are edited in the CMS.
"""

# Field helpers keep the forms below readable.


def yn(key, label, help=None, fail_on="no", fail_text=None):
    return {
        "key": key,
        "type": "yes_no",
        "label": label,
        "help": help,
        "required": True,
        "fail_on": fail_on,
        "fail_text": fail_text,
    }


def pf(key, label, help=None, fail_text=None):
    return {"key": key, "type": "pass_fail", "label": label, "help": help, "required": True, "fail_text": fail_text}


def num(key, label, unit, min=None, max=None, help=None):
    return {
        "key": key,
        "type": "number",
        "label": label,
        "unit": unit,
        "min": min,
        "max": max,
        "help": help,
        "required": True,
    }


def photo(key, label, help=None, min_photos=1):
    return {"key": key, "type": "photo", "label": label, "help": help, "required": True, "min_photos": min_photos}


def cert_file(key="certificate", label="Certificate or report (PDF)"):
    return {"key": key, "type": "file", "label": label, "required": True, "min_photos": 1}


def date_f(key, label):
    return {"key": key, "type": "date", "label": label, "required": True}


def notes():
    return {"key": "notes", "type": "text", "label": "Notes", "required": False}


def certificate_form(expiry_label="Expiry date"):
    return [
        cert_file(),
        date_f("issued_on", "Date of the visit or issue"),
        date_f("expires_on", expiry_label),
        yn("any_fails", "Does the report list any fails, C1/C2 codes or defects?", fail_on="yes"),
        photo("asset_photo", "Photo of the asset or label", min_photos=1),
        notes(),
    ]


# Domain keys -> names (editable, CMS-04)
DOMAINS = [
    ("fire", "Fire"),
    ("water", "Water"),
    ("gas", "Gas"),
    ("electrical", "Electrical"),
    ("hot_tub", "Hot tub & sauna"),
    ("hs", "H&S"),
    ("training", "Training"),
    ("licensing", "Licensing & insurance"),
    ("guests", "Guests"),
    ("data", "Data"),
]

CLASSES = [("A", "Life safety", 3), ("B", "Statutory", 2), ("C", "bide standard", 1)]

# Amber windows per frequency (§4.2): 3 days weekly and monthly, 14 quarterly and 6-monthly, 60 annual and longer
# and all certificates.
WINDOWS = [
    ("each_visit", 3),
    ("daily", 0),
    ("daily_in_use", 0),
    ("weekly", 3),
    ("monthly", 3),
    ("quarterly", 14),
    ("six_monthly", 14),
    ("annual", 60),
    ("two_yearly", 60),
    ("five_yearly", 60),
    ("ten_yearly", 60),
    ("certificate", 60),
]

LOCATION_TYPES = [
    ("panel", "Fire panel"),
    ("call_point", "Call point"),
    ("fire_door", "Fire door"),
    ("room", "Room"),
    ("plant", "Plant room"),
    ("hot_tub", "Hot tub"),
    ("sauna", "Sauna"),
    ("outlet", "Water outlet"),
    ("extinguisher", "Extinguisher point"),
    ("exit", "Exit or escape route"),
    ("other", "Other"),
]

STAFF_REQUIREMENTS = [
    ("fire_suite", "Fire suite courses (High Speed Training)", ["staff", "keyholder", "site_lead"], 12, False),
    ("manual_signed", "Training manual read and signed", ["staff", "keyholder", "site_lead"], None, False),
    ("right_to_work", "Right to work check", ["staff", "keyholder", "site_lead"], None, True),
    ("keyholder_drill", "Keyholder timed drill", ["keyholder"], 6, False),
    ("first_aid", "First aid", ["site_lead"], 36, False),
    ("personal_licence", "Personal licence", [], 60, False),
]

RETENTION = [
    # Drafted against Scottish limitation periods; David signs them off (§8 Retention, open question 7).
    (
        "completed_checks",
        6,
        "completion",
        "archive",
        "Prescription and Limitation (Scotland) Act 1973: 5 years, plus 1.",
    ),
    ("certificates", 6, "expiry", "archive", "Kept 6 years after the certificate is superseded or expires."),
    ("fire_records", 6, "completion", "archive", "Fire Safety (Scotland) Regs 2006; kept beyond the next FRA review."),
    ("incidents", 7, "completion", "archive", "RIDDOR minimum 3 years; personal injury claims run longer."),
    ("right_to_work", 2, "employment_end", "delete", "Home Office: copies kept for employment plus 2 years."),
    ("training_records", 6, "employment_end", "archive", "Evidence of competence for claims."),
    ("audit_log", 10, "completion", "archive", "Integrity of the evidence trail."),
    ("location_data", 1, "completion", "delete", "Data minimisation: geofence result kept, coordinates removed."),
]

# (domain, name, class, kind, frequency, done_by_hint, applies_note, applies_to, legal_basis, extra)
# extra: form, late_rule, verification, warning_days, frequency_note, guidance, typical_minutes, source_status,
#        geofence_required
MASTER: list[tuple] = [
    (
        "fire",
        "Escape routes, final exits and assembly point clear",
        "A",
        "cleaning",
        "each_visit",
        "Housekeeping",
        None,
        {},
        "Fire (Scotland) Act 2005",
        dict(
            frequency_note="Each visit, recorded weekly",
            typical_minutes=5,
            form=[
                yn("routes_clear", "Escape routes and corridors clear of obstructions"),
                yn("exits_open", "Final exits open easily from the inside"),
                yn("assembly_clear", "Assembly point clear and signed"),
                photo("route_photo", "Photo of the main escape route"),
                notes(),
            ],
        ),
    ),
    (
        "fire",
        "Fire alarm test, rotate call point, ARC signal confirmed",
        "A",
        "check",
        "weekly",
        "Keyholder",
        None,
        {"all": [{"feature": "has_fire_alarm"}]},
        "BS 5839-1; Fire Safety (Scotland) Regs 2006",
        dict(
            verification="always",
            typical_minutes=5,
            geofence_required=True,
            guidance="Use a different call point each week, in order. Tell the ARC before you start and ask them to "
            "confirm they received the signal. Reset the panel and check it shows normal.",
            form=[
                {
                    "key": "call_point",
                    "type": "location",
                    "label": "Call point tested",
                    "required": True,
                    "source": "call_point",
                    "help": "Suggests the next call point in rotation.",
                },
                yn(
                    "panel_normal",
                    "Panel shows normal after reset?",
                    fail_text="Fire panel did not return to normal after the weekly test",
                ),
                yn(
                    "arc_confirmed",
                    "Did the alarm company get the signal?",
                    help="Phone the alarm company and ask them to confirm they received the test signal.",
                    fail_text="Alarm company did not get the weekly test signal",
                ),
                pf("sounders", "Sounders audible in all zones", fail_text="Sounders not audible in every zone"),
                photo("panel_photo", "Panel showing normal", help="The panel display after reset, showing no faults."),
                photo(
                    "logbook_photo",
                    "Signed log book",
                    help="Fill the whole frame with today's entry and your signature.",
                ),
                notes(),
            ],
        ),
    ),
    (
        "fire",
        "Fire door walk-check (closing, seals, no wedges)",
        "A",
        "check",
        "weekly",
        "Housekeeping",
        None,
        {},
        "FS(S) Regs reg. 15",
        dict(
            typical_minutes=15,
            form=[
                yn("closing", "Every fire door closes fully and latches on its own"),
                yn("seals", "Intumescent strips and smoke seals in place and undamaged"),
                yn("no_wedges", "No doors wedged or held open"),
                {
                    "key": "doors_failed",
                    "type": "text",
                    "label": "Doors that failed (number and floor)",
                    "required": False,
                },
                photo("door_photo", "Photo of a door closing onto its frame"),
                notes(),
            ],
        ),
    ),
    (
        "fire",
        "Emergency lighting flick test",
        "A",
        "check",
        "monthly",
        "Keyholder",
        None,
        {},
        "BS 5266-1",
        dict(
            typical_minutes=10,
            form=[
                pf("all_lit", "Every emergency light came on during the test"),
                {"key": "lights_failed", "type": "text", "label": "Lights that failed", "required": False},
                yn("restored", "All lights back to normal charging after the test"),
                photo("light_photo", "Photo of a fitting lit during the test"),
                notes(),
            ],
        ),
    ),
    (
        "fire",
        "Salto door release on alarm and power failure, all escape doors",
        "A",
        "check",
        "monthly",
        "Keyholder + Rowell",
        "Salto doors fitted",
        {"all": [{"feature": "has_salto"}]},
        "BS 7273",
        dict(
            form=[
                pf("release_alarm", "Every escape door released when the alarm sounded"),
                pf("release_power", "Every escape door released on power failure"),
                photo("door_photo", "Photo of a released escape door"),
                notes(),
            ]
        ),
    ),
    (
        "fire",
        "Extinguishers and blankets visual check",
        "B",
        "check",
        "monthly",
        "Keyholder",
        None,
        {},
        "BS 5306-3",
        dict(
            form=[
                yn("in_place", "Every extinguisher and blanket in its place"),
                yn("gauges", "Pressure gauges in the green, pins and tamper tags intact"),
                photo("ext_photo", "Photo of an extinguisher point"),
                notes(),
            ]
        ),
    ),
    (
        "fire",
        "Fire door formal inspection per door (BS 8214)",
        "A",
        "contractor_visit",
        "quarterly",
        "Competent person",
        None,
        {},
        "BS 8214",
        dict(
            form=[
                cert_file("report", "Inspection report (PDF)"),
                yn("any_fails", "Does the report list doors that failed?", fail_on="yes"),
                photo("site_photo", "Photo on site"),
                notes(),
            ]
        ),
    ),
    (
        "fire",
        "Fire alarm service and certificate (BS 5839-1)",
        "A",
        "certificate",
        "six_monthly",
        "Nova / alarm contractor",
        None,
        {"all": [{"feature": "has_fire_alarm"}]},
        "BS 5839-1",
        dict(verification="always", form=certificate_form("Next service due")),
    ),
    (
        "fire",
        "Keyholder timed drill (target 5 min, max 10)",
        "A",
        "check",
        "six_monthly",
        "Site lead",
        "Unmanned properties",
        {"all": [{"feature": "unmanned"}]},
        "FRA · unmanned properties",
        dict(
            form=[
                num("minutes", "Minutes from call to keyholder on site", "min", max=10),
                {"key": "keyholder", "type": "text", "label": "Keyholder who attended", "required": True},
                photo("arrival_photo", "Photo on arrival at the panel"),
                notes(),
            ]
        ),
    ),
    (
        "fire",
        "Fire Response Plan and keyholder list review; ARC contacts current",
        "A",
        "check",
        "six_monthly",
        "Samantha",
        None,
        {},
        "Fire (Scotland) Act 2005; FRA",
        dict(
            frequency_note="6-monthly + on change",
            form=[
                yn("plan_current", "Fire Response Plan reviewed and current"),
                yn("keyholders_current", "Keyholder list current, with at least two who can attend within 10 minutes"),
                yn("arc_current", "ARC holds the current contacts and call order"),
                {"key": "plan_file", "type": "file", "label": "Reviewed plan (PDF)", "required": True, "min_photos": 1},
                notes(),
            ],
        ),
    ),
    (
        "fire",
        "Emergency lighting 3-hour test certificate (BS 5266-1)",
        "A",
        "certificate",
        "annual",
        "Electrician",
        None,
        {},
        "BS 5266-1",
        dict(verification="always", form=certificate_form()),
    ),
    (
        "fire",
        "Extinguisher service certificate",
        "B",
        "certificate",
        "annual",
        "BAFE contractor",
        None,
        {},
        "BS 5306-3",
        dict(form=certificate_form()),
    ),
    (
        "fire",
        "FRA review and signature",
        "A",
        "certificate",
        "annual",
        "Assessor + dutyholder",
        None,
        {},
        "Fire (Scotland) Act 2005; Fire Safety (Scotland) Regs 2006",
        dict(
            verification="always",
            frequency_note="Annual + on change",
            form=[
                cert_file("fra", "Fire Risk Assessment (PDF)"),
                date_f("issued_on", "Assessment date"),
                date_f("expires_on", "Review due"),
                notes(),
            ],
        ),
    ),
    (
        "fire",
        "Furniture fire certificates; audit on any replacement",
        "B",
        "certificate",
        "annual",
        "Procurement",
        None,
        {},
        "Furniture and Furnishings (Fire) (Safety) Regs 1988",
        dict(frequency_note="Annual + on change", form=certificate_form("Next audit due")),
    ),
    (
        "fire",
        "Alarm events and false alarm log (3 same cause = engineering review)",
        "B",
        "check",
        "each_event",
        "Keyholder",
        None,
        {"all": [{"feature": "has_fire_alarm"}]},
        "BS 5839-1 §30",
        dict(
            form=[
                {"key": "zone", "type": "text", "label": "Zone or device", "required": True},
                {
                    "key": "cause",
                    "type": "select",
                    "label": "Cause",
                    "required": True,
                    "options": [
                        "Cooking",
                        "Steam or shower",
                        "Smoking or vaping",
                        "Dust or works",
                        "Malicious",
                        "Equipment fault",
                        "Real fire",
                        "Unknown",
                    ],
                },
                num("attend_minutes", "Keyholder attendance time", "min", max=10),
                photo("panel_photo", "Panel after reset"),
                notes(),
            ]
        ),
    ),
    (
        "electrical",
        "PAT of guest, kitchenette, laundry and wellness appliances",
        "B",
        "certificate",
        "annual",
        "Competent person",
        None,
        {},
        "IET Code of Practice",
        dict(frequency_note="Annual (bide standard)", form=certificate_form()),
    ),
    (
        "electrical",
        "EICR (BS 7671)",
        "B",
        "certificate",
        "five_yearly",
        "Electrician",
        None,
        {},
        "BS 7671",
        dict(form=certificate_form("Next inspection due")),
    ),
    (
        "gas",
        "Gas Safe CP12 and boiler service (OFTEC service where oil-fired)",
        "A",
        "certificate",
        "annual",
        "Gas Safe / OFTEC engineer",
        "Gas or oil heating",
        {"any": [{"feature": "has_gas"}, {"feature": "has_oil"}]},
        "Gas Safety (Installation & Use) Regs 1998",
        dict(verification="always", form=certificate_form()),
    ),
    (
        "gas",
        "Carbon monoxide alarm test",
        "A",
        "check",
        "monthly",
        "Keyholder",
        "Any combustion appliance or flue",
        {"any": [{"feature": "has_gas"}, {"feature": "has_oil"}, {"feature": "has_stove"}]},
        "BS EN 50291",
        dict(
            form=[
                pf("all_sound", "Every CO alarm sounded when tested"),
                {"key": "alarms_failed", "type": "text", "label": "Alarms that failed", "required": False},
                photo("alarm_photo", "Photo of a CO alarm during the test"),
                notes(),
            ]
        ),
    ),
    (
        "water",
        "Hot and cold outlet temperatures logged",
        "B",
        "check",
        "monthly",
        "Site lead",
        None,
        {},
        "HSE L8",
        dict(
            late_rule="missed",
            form=[
                {"key": "outlet", "type": "text", "label": "Outlet (room and tap)", "required": True},
                num(
                    "hot",
                    "Hot water at outlet after 1 minute",
                    "°C",
                    min=50,
                    help="Run the hot tap for one minute, then read the thermometer.",
                ),
                num("cold", "Cold water at outlet after 2 minutes", "°C", max=20),
                photo("thermo_photo", "Photo of the thermometer reading"),
                notes(),
            ],
        ),
    ),
    (
        "water",
        "Flush little-used outlets and empty rooms",
        "B",
        "cleaning",
        "weekly",
        "Housekeeping",
        None,
        {},
        "HSE L8",
        dict(
            form=[
                yn("flushed", "Every little-used outlet run for at least 2 minutes"),
                {"key": "rooms", "type": "text", "label": "Rooms flushed", "required": True},
                photo("tap_photo", "Photo of a running outlet"),
                notes(),
            ]
        ),
    ),
    (
        "water",
        "Showerheads cleaned and descaled",
        "B",
        "cleaning",
        "quarterly",
        "Housekeeping",
        None,
        {},
        "HSE L8",
        dict(
            form=[
                yn("descaled", "Every showerhead cleaned and descaled"),
                photo("shower_photo", "Photo of a cleaned head"),
                notes(),
            ]
        ),
    ),
    (
        "water",
        "Legionella risk assessment review",
        "B",
        "certificate",
        "two_yearly",
        "Assessor",
        None,
        {},
        "HSE L8",
        dict(verification="always", frequency_note="2-yearly + on change", form=certificate_form("Review due")),
    ),
    (
        "hot_tub",
        "Hot tub chemical readings logged (HSG282)",
        "A",
        "check",
        "daily_in_use",
        "Site lead",
        "Hot tub",
        {"all": [{"feature": "has_hot_tub"}]},
        "HSE HSG282",
        dict(
            late_rule="missed",
            form=[
                num("chlorine", "Free chlorine", "mg/l", min=3, max=5),
                num("ph", "pH", "", min=7.0, max=7.6),
                yn("clear", "Water clear, no foaming"),
                photo("test_photo", "Photo of the test kit reading"),
                notes(),
            ],
        ),
    ),
    (
        "hot_tub",
        "Microbiological sample / Legionella sample",
        "B",
        "certificate",
        "quarterly",
        "Lab contractor",
        "Hot tub",
        {"all": [{"feature": "has_hot_tub"}]},
        "HSE HSG282",
        dict(frequency_note="Monthly / quarterly", form=certificate_form("Next sample due")),
    ),
    (
        "hot_tub",
        "Sauna: heater clear, guard, timer cut-off, rules sign",
        "A",
        "check",
        "each_visit",
        "Housekeeping",
        "Sauna",
        {"all": [{"feature": "has_sauna"}]},
        "BS EN 60335-2-53",
        dict(
            form=[
                yn("heater_clear", "Nothing on or near the heater"),
                yn("guard", "Heater guard fitted and secure"),
                pf("timer", "Timer cuts off at the set time"),
                yn("sign", "Sauna rules sign displayed"),
                photo("sauna_photo", "Photo of the heater and guard"),
                notes(),
            ]
        ),
    ),
    (
        "hs",
        "First aid kit check; accident book reviewed (RIDDOR)",
        "B",
        "check",
        "monthly",
        "Site lead",
        None,
        {},
        "Health and Safety (First-Aid) Regs 1981; RIDDOR 2013",
        dict(
            form=[
                yn("kit_complete", "First aid kit complete and in date"),
                yn("book_reviewed", "Accident book reviewed; anything RIDDOR-reportable reported"),
                photo("kit_photo", "Photo of the open kit"),
                notes(),
            ]
        ),
    ),
    (
        "hs",
        "COSHH register and locked chemical store",
        "B",
        "check",
        "annual",
        "Samantha",
        None,
        {},
        "COSHH Regs 2002",
        dict(
            frequency_note="Annual review",
            form=[
                yn("register_current", "COSHH register lists every product in use with its data sheet"),
                yn("store_locked", "Chemical store locked"),
                photo("store_photo", "Photo of the chemical store"),
                notes(),
            ],
        ),
    ),
    (
        "training",
        "Fire suite courses done before working alone; renewals",
        "B",
        "staff",
        "on_hire",
        "Lynne tracks",
        "All staff",
        {},
        "Fire (Scotland) Act 2005 s.54 (training)",
        dict(form=[cert_file("certificate", "Course certificate"), date_f("expires_on", "Renewal date")]),
    ),
    (
        "guests",
        "PEEP for every declared guest; maximum occupancy set in Mews",
        "A",
        "check",
        "each_booking",
        "Rowell",
        None,
        {},
        "Equality Act 2010; FRA",
        dict(
            frequency_note="Each booking / on change",
            form=[
                yn("peep_done", "PEEP completed for every guest who declared a need"),
                yn("occupancy", "Maximum occupancy set in Mews for every room"),
                {"key": "peep_file", "type": "file", "label": "PEEP record", "required": True, "min_photos": 1},
                notes(),
            ],
        ),
    ),
    (
        "guests",
        "Guest fire information and evacuate message tested",
        "B",
        "check",
        "quarterly",
        "Rowell",
        None,
        {},
        "FRA",
        dict(
            form=[
                yn("info_current", "Guest fire information current in every room and in the guest app"),
                pf("message_test", "Evacuate message sent and received in a test"),
                photo("info_photo", "Photo of the in-room fire information"),
                notes(),
            ]
        ),
    ),
    (
        "licensing",
        "Insurance renewal and insurer fire conditions met",
        "B",
        "certificate",
        "annual",
        "David",
        None,
        {},
        "Policy conditions",
        dict(frequency_note="Annual + on change", form=certificate_form("Renewal date")),
    ),
    (
        "licensing",
        "Premises licence if alcohol is sold",
        "B",
        "certificate",
        "per_licence",
        "David",
        "Alcohol sold (to confirm per property)",
        {"all": [{"feature": "has_alcohol"}]},
        "Licensing (Scotland) Act 2005",
        dict(form=certificate_form()),
    ),
    (
        "licensing",
        "STL licence conditions and renewals",
        "B",
        "certificate",
        "per_licence",
        "Lynne",
        "bide Stays units",
        {"all": [{"licence_regime": "stl"}]},
        "Civic Government (Scotland) Act 1982 (Licensing of Short-term Lets) Order 2022",
        dict(form=certificate_form()),
    ),
    (
        "data",
        "CCTV policy, signage and retention (UK GDPR)",
        "C",
        "check",
        "annual",
        "Samantha",
        "CCTV fitted",
        {"all": [{"feature": "has_cctv"}]},
        "UK GDPR; ICO CCTV guidance",
        dict(
            form=[
                yn("policy_current", "CCTV policy reviewed"),
                yn("signage", "Signage displayed at every camera area"),
                yn("retention", "Recordings deleted on the retention schedule"),
                photo("sign_photo", "Photo of the signage"),
                notes(),
            ]
        ),
    ),
]

PROPOSED: list[tuple] = [
    (
        "licensing",
        "Employers' liability certificate",
        "B",
        "certificate",
        "annual",
        "David",
        "All SPVs",
        {},
        "Employers' Liability (Compulsory Insurance) Act 1969; BH-CMP-002 A06",
        {},
    ),
    (
        "data",
        "ICO data protection fee",
        "B",
        "certificate",
        "annual",
        "David",
        "All SPVs",
        {},
        "Data Protection (Charges and Information) Regs 2018; BH-CMP-002 A07",
        {},
    ),
    (
        "training",
        "Right-to-work check before employment, with follow-up checks for time-limited permission",
        "B",
        "staff",
        "on_hire",
        "Lynne",
        "All staff",
        {},
        "Home Office employer's guide to right to work checks",
        {},
    ),
    (
        "hs",
        "Sponsor licence duties (record keeping, reporting changes to the Home Office)",
        "B",
        "check",
        "monthly",
        "Lynne",
        "If any SPV sponsors overseas workers",
        {"all": [{"feature": "sponsor_licence"}]},
        "Standard practice (verify with adviser)",
        {},
    ),
    (
        "licensing",
        "Personal licence refresher within 5 years of issue, sent to the Licensing Board",
        "B",
        "staff",
        "five_yearly",
        "Lynne",
        "Alcohol sold",
        {"all": [{"feature": "has_alcohol"}]},
        "Licensing (Scotland) Act 2005",
        {},
    ),
    (
        "hs",
        "Food safety: CookSafe system review, temperature records, 14-allergen information",
        "B",
        "check",
        "annual",
        "Site lead",
        "Food prepared or served (gate A08)",
        {"all": [{"feature": "has_food"}]},
        "FSS CookSafe",
        {},
    ),
    (
        "licensing",
        "STL display items, including the two added by the 2024 Amendment Order, and a valid EPC",
        "B",
        "check",
        "quarterly",
        "Lynne",
        "bide Stays STL units",
        {"all": [{"licence_regime": "stl"}]},
        "gov.scot STL guidance",
        {},
    ),
    (
        "hs",
        "General H&S and lone-working risk assessment review",
        "B",
        "check",
        "annual",
        "Samantha",
        "All",
        {},
        "Management of Health and Safety at Work Regs 1999; BH-CMP-002 H06",
        {},
    ),
    (
        "fire",
        "Quarterly dutyholder register sign-off and quarterly assessor audit walk",
        "A",
        "check",
        "quarterly",
        "SPV directors + assessor",
        "All",
        {},
        "BH-CMP-001 §6.2 and §7",
        {},
    ),
    (
        "hs",
        "Visitor levy returns",
        "B",
        "check",
        "quarterly",
        "Lynne",
        "Only if a property's council runs a levy; none of the current properties are in Edinburgh",
        {"all": [{"feature": "visitor_levy"}]},
        "City of Edinburgh Council",
        {},
    ),
]


def default_form(kind: str, name: str) -> list[dict]:
    if kind in ("certificate", "contractor_visit"):
        return certificate_form()
    if kind == "staff":
        return [cert_file("certificate", "Certificate or record"), date_f("expires_on", "Renewal or expiry date")]
    return [yn("done", f"{name}: done and nothing wrong found"), photo("photo", "Photo of the evidence"), notes()]


# BH-CMP-002 opening gate, 56 items in sections A–H. Lines whose wording appears in the design or the PRD are filled
# in. The rest carry their ref and Class only, and get their wording from the BH-CMP-002 workbook through
# Settings › Import (CMS-06).
GATE_SECTION_SIZES = {"A": 8, "B": 6, "C": 13, "D": 7, "E": 2, "F": 7, "G": 5, "H": 8}
TO_LOAD = "Wording loads from the BH-CMP-002 workbook (Settings › Import)"

GATE_KNOWN: dict[str, tuple] = {
    # ref: (item, class, legal basis, evidence required, typical owner)
    "A01": (
        "Building warrant completion certificate accepted",
        "A",
        "Building (Scotland) Act 2003",
        "Completion certificate PDF",
        "David",
    ),
    "A03": (
        "Short-term let licensing position confirmed (Class 7 hotels are normally outside STL licensing)",
        "B",
        "Civic Government (Scotland) Act 1982 (Licensing of Short-term Lets) Order 2022",
        "Written confirmation",
        "David",
    ),
    "A05": (
        "Buildings and liability insurance in place, insurer fire conditions met",
        "A",
        "Policy conditions",
        "Policy schedule + insurer confirmation",
        "David",
    ),
    "A06": (
        "Employers' liability certificate",
        "B",
        "Employers' Liability (Compulsory Insurance) Act 1969",
        "EL certificate",
        "David",
    ),
    "A07": (
        "ICO data protection fee paid",
        "B",
        "Data Protection (Charges and Information) Regs 2018",
        "ICO registration",
        "David",
    ),
    "A08": (
        "Food safety: CookSafe system in place where food is prepared or served",
        "B",
        "FSS CookSafe",
        "CookSafe pack",
        "Site lead",
    ),
    "B02": (
        "Fire Risk Assessment and Fire Plan signed by the dutyholder after a site walk",
        "A",
        "Fire (Scotland) Act 2005; Fire Safety (Scotland) Regs 2006",
        "Signed FRA",
        "SPV director",
    ),
    "B03": (
        "Competent assessor countersigns the FRA",
        "A",
        "Fire (Scotland) Act 2005",
        "Countersigned FRA",
        "Assessor",
    ),
    "B04": (
        "ARC call order decided and recorded in the FRA; Fire Response Plan agreed",
        "A",
        "BS 5839-1; FRA",
        "FRA section + ARC confirmation",
        "David",
    ),
    "B06": ("SFRS familiarisation visit invited", "C", "bide standard", "Email to SFRS", "Lynne"),
    "C01": ("Fire alarm commissioned to BS 5839-1 (L1 for bide)", "A", "BS 5839-1", "Certificates in 05 / 09", "Nova"),
    "C02": (
        "Bedhead sounder levels measured in every bedroom (75 dB(A))",
        "A",
        "BS 5839-1",
        "Room-by-room reading sheet",
        "Nova",
    ),
    "C03": ("Zone chart completed and displayed at the panel", "A", "BS 5839-1", "Photo of panel and chart", "Nova"),
    "C04": (
        "ARC monitoring live; keyholder schedule; end-to-end and 999 test",
        "A",
        "BS 5839-1; BS 8591",
        "ARC confirmation + test record",
        "David",
    ),
    "C05": (
        "Salto door release on alarm and power failure, every escape door",
        "A",
        "BS 7273",
        "Test record per door",
        "Rowell",
    ),
    "C06": ("Roof void and concealed space detection confirmed", "A", "BS 5839-1", "Contractor confirmation", "Nova"),
    "C07": (
        "Emergency lighting commissioned with 3-hour certificate",
        "A",
        "BS 5266-1",
        "EL certificate",
        "Electrician",
    ),
    "C08": (
        "Extinguishers and fire blankets installed, tagged, certified",
        "B",
        "BS 5306-3",
        "BAFE certificate + photos",
        "Lynne",
    ),
    "C09": (
        "Fire doors: certificated, per-door record, labelled, gaps 3–4 mm",
        "A",
        "BS 8214",
        "Door certs, per-door record, photos",
        "Lynne",
    ),
    "C10": (
        "Fire-stopping and compartmentation photo pack accepted",
        "A",
        "Building (Scotland) Regs 2004",
        "Photo pack + fire engineer sign-off",
        "David",
    ),
    "C11": (
        "Statutory signage incl. fire action notice on every bedroom door",
        "A",
        "Health and Safety (Safety Signs) Regs 1996",
        "Photos",
        "Site lead",
    ),
    "C12": (
        "Per-room exit plans checked against the building and fitted",
        "B",
        "FRA",
        "Signed review + photos",
        "Samantha",
    ),
    "C13": (
        "Accessible WC pull cord alerts someone off site",
        "A",
        "Building (Scotland) Regs 2004; FRA",
        "Test record",
        "Rowell",
    ),
    "D01": (
        "EICR, PAT, Gas Safe CP12 and legionella risk assessment on file",
        "A",
        "BS 7671; Gas Safety (Installation & Use) Regs 1998; HSE L8",
        "Certificates",
        "Lynne",
    ),
    "D02": (
        "PAT of all guest and staff appliances, fails removed or repaired",
        "B",
        "IET Code of Practice",
        "PAT report",
        "Lynne",
    ),
    "D05": ("Legionella risk assessment in place", "B", "HSE L8", "LRA report", "Lynne"),
    "E01": (
        "Furniture fire certificates for every item",
        "B",
        "Furniture and Furnishings (Fire) (Safety) Regs 1988",
        "Certificates",
        "Procurement",
    ),
    "G04": ("Assembly point sign fitted and shown on the guest fire information", "A", "FRA", "Photo", "Site lead"),
    "H01": ("Weekly alarm test started and logged at the panel", "A", "BS 5839-1", "Log book entries", "Keyholder"),
    "H02": ("Recurring checks loaded into the register", "A", "BH-CMP-001", "Register live in bide Comply", "Samantha"),
    "H03": (
        "Compliance folders 01–09 set up; signed weekly and monthly logs filed",
        "B",
        "BH-CMP-001",
        "Folder 07 contents",
        "Lynne",
    ),
    "H06": (
        "General H&S and lone-working risk assessment",
        "B",
        "Management of Health and Safety at Work Regs 1999",
        "Signed risk assessment",
        "Samantha",
    ),
    "H07": ("CCTV policy, signage and retention set (if CCTV fitted)", "C", "UK GDPR", "Policy + photos", "Samantha"),
    "H08": ("Gate sign-off by the SPV dutyholder", "A", "BH-CMP-002", "Signed statement", "SPV director"),
}

# Class A lines per section, from The Villa's gate in the design (31 life-safety items in all).
GATE_CLASS_A = {"A": 2, "B": 4, "C": 11, "D": 4, "E": 0, "F": 4, "G": 3, "H": 3}


def gate_template() -> list[dict]:
    items = []
    sort = 0
    for sec, size in GATE_SECTION_SIZES.items():
        refs = [f"{sec}{n:02d}" for n in range(1, size + 1)]
        known_a = sum(1 for r in refs if r in GATE_KNOWN and GATE_KNOWN[r][1] == "A")
        spare_a = max(GATE_CLASS_A[sec] - known_a, 0)
        for ref in refs:
            sort += 1
            if ref in GATE_KNOWN:
                item, klass, basis, ev, owner = GATE_KNOWN[ref]
            else:
                klass = "A" if spare_a > 0 else "B"
                spare_a -= klass == "A"
                item, basis, ev, owner = f"{ref} · {TO_LOAD}", None, None, None
            items.append(
                {
                    "ref": ref,
                    "section": sec,
                    "item": item,
                    "class": klass,
                    "legal_basis": basis,
                    "evidence_required": ev,
                    "typical_owner": owner,
                    "sort": sort,
                }
            )
    return items

// ============================================================
// Sungrow SH10RT – Adaptive Ladesteuerung
// Version: 1.0.4
// Modus: DRY_RUN = true → kein Schreiben, nur Logging
// ============================================================
//
// CHANGELOG
// ---------
// v1.0.4 – 2026-05-09
//   - PV_PROGNOSE_HOCH von 50.000 auf 40.000 Wh gesenkt (Anlage max ~60 kWh,
//     Tagesverbrauch ~13 kWh; empirisch bestätigt dass 30 kWh Produktion
//     bereits für volle Batterie + Einspeisung reicht)
//
// v1.0.3 – 2026-05-09
//   - Logikfehler: SOC-Rückstand basierte auf letzterWert (Ceiling), nicht
//     auf basisLeistung (Minimum zum Erreichen des Ziels). Neu: speichert
//     basisLeistungVorigeStunde als Referenz für den erwarteten SOC-Anstieg
//   - Floating Point Fix: Rückstand wird auf 1 Dezimalstelle gerundet
//
// v1.0.2 – 2026-05-09
//   - Schedule auf Minute :02 verschoben (pvforecast aktualisiert bei :00:30)
//   - restStunden-Berechnung auf volle Stunden vereinfacht (Minuten ignoriert)
//
// v1.0.1 – 2026-05-09
//   - PV-Verhältnis Log: irreführende Meldung "Tagesprognose noch nicht
//     gesetzt" ersetzt durch echten Grund inkl. pvNow-Wert in kWh
//
// v1.0.0 – 2026-05-06
//   - Erstveröffentlichung: adaptive Ladesteuerung für Sungrow SH10RT
//   - START_STUNDE=8, Zeitfenster 8–17 Uhr, DRY_RUN=true
// ============================================================

// ============================================================
// KONFIGURATION – hier anpassen
// ============================================================

var DRY_RUN         = true;    // true = Testmodus, kein Schreiben ins Register

var ZIEL_UHRZEIT    = 16;      // Uhr – Batterie soll bis dahin voll sein
var ZIEL_SOC        = 100;     // % – Ziel-Ladestand
var BATTERIE_KWH    = 9.6;     // kWh – nutzbare Kapazität SBR096
var MAX_LEISTUNG    = 6570;    // W – maximale Ladeleistung, wr kann bis 10,6kWh
var MIN_LEISTUNG    = 500;     // W – Minimum (verhindert Abbruch des Ladevorgangs)
var START_STUNDE    = 8;       // Uhr – Steuerung aktiv ab (erste Stunde dient als Referenz für SOC-Rückstand)
var END_STUNDE      = 17;      // Uhr – Steuerung aktiv bis (letzte adaptive Entscheidung um END_STUNDE-1 Uhr)

// PV-Prognose Schwellwert: ab dieser Tagesmenge "entspannt" laden
var PV_PROGNOSE_HOCH = 40000; // Wh – sonniger Tag → sanft mit 1500W starten

// Leistung bei viel Sonne (Grundlast)
var LEISTUNG_SANFT  = 1500;   // W

// SOC-Rückstand Schwellen (kumuliert über den Tag)
var RUECKSTAND_MODERAT  = 5;  // % – Leistung um 50% erhöhen
var RUECKSTAND_KRITISCH = 10; // % – sofort auf MAX_LEISTUNG

// PV-Verhältnis Schwellen (tatsächlich / prognostiziert)
var PV_VERH_GUT     = 0.9;    // über 90% → Plan hält
var PV_VERH_MODERAT = 0.7;    // 70–90% → etwas erhöhen
                               // unter 70% → sofort MAX_LEISTUNG

// ============================================================
// DATENPUNKTE
// ============================================================

var DP_SOC          = 'modbus.0.inputRegisters.13022_Battery_level_';
var DP_PV_HEUTE     = 'modbus.0.inputRegisters.13001_Daily_PV_Generation';   // kWh
var DP_PV_PROGNOSE  = 'pvforecast.0.summary.energy.nowUntilEndOfDay';        // Wh – noch zu erwarten
var DP_PV_NOW       = 'pvforecast.0.summary.energy.now';                     // Wh – heute laut Prognose bereits erzeugt
var DP_HR_LADEN     = 'modbus.0.holdingRegisters.33046_Max_Charging_Power';  // W

// ============================================================
// ZUSTAND (wird zur Laufzeit gehalten)
// ============================================================

var letzterWert              = null;   // zuletzt geschriebene Ladeleistung (W)
var socVorEinerStunde        = null;   // SOC-Wert der letzten Stunde
var basisLeistungVorigeStunde = null;  // Basisleistung der Vorperiode (Referenz für SOC-Anstieg)
var kumulierterRueckstand    = 0;      // % – Summe der SOC-Rückstände über den Tag
var tagesPrognose            = null;   // Wh – Prognose gesamt (wird um START_STUNDE gesetzt)

// ============================================================
// HILFSFUNKTIONEN
// ============================================================

function log_info(msg) {
    log('[Ladesteuerung] ' + msg, 'info');
}

function log_warn(msg) {
    log('[Ladesteuerung] ⚠️  ' + msg, 'warn');
}

function schreibeLeistung(leistung, grund) {
    // Auf 100W runden
    leistung = Math.round(leistung / 100) * 100;
    leistung = Math.max(MIN_LEISTUNG, Math.min(MAX_LEISTUNG, leistung));

    var geaendert = (letzterWert === null || Math.abs(leistung - letzterWert) > 100);

    if (!geaendert) {
        log_info('Keine Änderung nötig – bleibt bei ' + leistung + 'W | Grund: ' + grund);
        return;
    }

    if (DRY_RUN) {
        log_info('[DRY RUN] Würde schreiben: ' + leistung + 'W (vorher: ' + letzterWert + 'W) | ' + grund);
    } else {
        setState(DP_HR_LADEN, leistung);
        log_info('Geschrieben: ' + leistung + 'W (vorher: ' + letzterWert + 'W) | ' + grund);
    }

    letzterWert = leistung;
}

function berechneBasisleistung(soc, restStunden) {
    var fehlendeProzent = Math.max(0, ZIEL_SOC - soc);
    var fehlendeKwh     = fehlendeProzent / 100 * BATTERIE_KWH;
    if (restStunden <= 0) return MAX_LEISTUNG;
    return Math.round(fehlendeKwh / restStunden * 1000);
}

// ============================================================
// HAUPTLOGIK – läuft stündlich
// ============================================================

schedule('2 8-17 * * *', function() {

    var jetzt       = new Date();
    var stunde      = jetzt.getHours();

    log_info('=== Stündliche Prüfung | ' + jetzt.toLocaleTimeString('de-DE') + ' ===');

    // --- Tagesstart: Prognose merken ---
    if (stunde === START_STUNDE) {
        tagesPrognose              = getState(DP_PV_PROGNOSE).val + getState(DP_PV_NOW).val;
        kumulierterRueckstand      = 0;
        socVorEinerStunde          = null;
        basisLeistungVorigeStunde  = null;
        log_info('Tagesstart – Tagesprognose gesamt: ' + (tagesPrognose / 1000).toFixed(1) + ' kWh');
    }

    // --- Außerhalb Zeitfenster ---
    if (stunde < START_STUNDE || stunde >= END_STUNDE) {
        schreibeLeistung(MAX_LEISTUNG, 'Außerhalb Zeitfenster ' + START_STUNDE + '–' + END_STUNDE + ' Uhr → volle Leistung');
        socVorEinerStunde = null;
        return;
    }

    // --- Werte lesen ---
    var soc         = getState(DP_SOC).val;
    var pvHeuteKwh  = getState(DP_PV_HEUTE).val;                   // kWh
    var pvHeuteWh   = pvHeuteKwh * 1000;                           // in Wh umrechnen
    var pvNowWh     = getState(DP_PV_NOW).val;                     // Wh – Prognose für bereits vergangene Zeit
    var pvNochWh    = getState(DP_PV_PROGNOSE).val;                // Wh – noch zu erwarten heute
    var restStunden = Math.max(0, ZIEL_UHRZEIT - stunde);
    var basisLeistung = berechneBasisleistung(soc, restStunden);

    log_info('SOC: ' + soc + '% | PV heute: ' + pvHeuteKwh.toFixed(1) + ' kWh | ' +
             'PV Prognose noch: ' + (pvNochWh / 1000).toFixed(1) + ' kWh | ' +
             'Reststunden bis ' + ZIEL_UHRZEIT + ' Uhr: ' + restStunden.toFixed(1) + 'h | ' +
             'Basisleistung: ' + basisLeistung + 'W');

    // --- SOC bereits erreicht ---
    if (soc >= ZIEL_SOC) {
        log_info('Ziel-SOC ' + ZIEL_SOC + '% erreicht – WR regelt selbst');
        schreibeLeistung(MAX_LEISTUNG, 'Ziel-SOC erreicht, WR übernimmt Regelung');
        socVorEinerStunde = soc;
        return;
    }

    // --- Zeit überschritten ---
    if (restStunden <= 0) {
        log_warn('Zieluhrzeit ' + ZIEL_UHRZEIT + ':00 überschritten – volle Leistung');
        schreibeLeistung(MAX_LEISTUNG, 'Zieluhrzeit überschritten');
        socVorEinerStunde = soc;
        return;
    }

    // -------------------------------------------------------
    // ENTSCHEIDUNG 1: PV-Verhältnis prüfen
    // -------------------------------------------------------
    var pvVerhaeltnis   = null;
    var pvVerhaeltnisText = 'unbekannt (pvNow zu gering: ' + (pvNowWh / 1000).toFixed(2) + ' kWh < 0.5 kWh Schwelle)';

    if (pvNowWh > 500) {
        // Erst ab 500Wh Prognose sinnvoll vergleichen
        pvVerhaeltnis     = pvHeuteWh / pvNowWh;
        pvVerhaeltnisText = (pvVerhaeltnis * 100).toFixed(0) + '% (real ' +
                            (pvHeuteWh / 1000).toFixed(1) + ' kWh / erwartet ' +
                            (pvNowWh / 1000).toFixed(1) + ' kWh)';
    }

    log_info('PV-Verhältnis: ' + pvVerhaeltnisText);

    // -------------------------------------------------------
    // ENTSCHEIDUNG 2: SOC-Rückstand prüfen
    // -------------------------------------------------------
    if (socVorEinerStunde !== null && basisLeistungVorigeStunde !== null) {
        var socAnstiegIst         = soc - socVorEinerStunde;
        var socAnstiegErwartet    = Math.round(basisLeistungVorigeStunde / 1000 / BATTERIE_KWH * 100);
        var rueckstandDieseStunde = Math.max(0, Math.round((socAnstiegErwartet - socAnstiegIst) * 10) / 10);
        kumulierterRueckstand    += rueckstandDieseStunde;

        log_info('SOC-Anstieg: erwartet ' + socAnstiegErwartet + '% / tatsächlich ' + socAnstiegIst.toFixed(1) + '% | ' +
                 'Rückstand diese Stunde: ' + rueckstandDieseStunde.toFixed(1) + '% | ' +
                 'Kumulierter Rückstand: ' + kumulierterRueckstand.toFixed(1) + '%');
    } else {
        log_info('SOC-Rückstand: noch kein Vorwert (erste Stunde)');
    }

    socVorEinerStunde = soc;

    // -------------------------------------------------------
    // ENTSCHEIDUNG 3: Leistung bestimmen
    // -------------------------------------------------------
    var leistung;
    var grund;

    // Kritischer SOC-Rückstand → sofort Maximum
    if (kumulierterRueckstand >= RUECKSTAND_KRITISCH) {
        leistung = MAX_LEISTUNG;
        grund    = 'KRITISCHER SOC-Rückstand (' + kumulierterRueckstand.toFixed(1) + '% kumuliert) → sofort ' + MAX_LEISTUNG + 'W';
        log_warn(grund);

    // PV deutlich schlechter als erwartet → Maximum
    } else if (pvVerhaeltnis !== null && pvVerhaeltnis < PV_VERH_MODERAT) {
        leistung = MAX_LEISTUNG;
        grund    = 'PV deutlich unter Prognose (' + (pvVerhaeltnis * 100).toFixed(0) + '%) → sofort ' + MAX_LEISTUNG + 'W';
        log_warn(grund);

    // Moderater SOC-Rückstand → Basisleistung × 1.5
    } else if (kumulierterRueckstand >= RUECKSTAND_MODERAT) {
        leistung = Math.round(basisLeistung * 1.5);
        grund    = 'Moderater SOC-Rückstand (' + kumulierterRueckstand.toFixed(1) + '%) → Basisleistung × 1.5 = ' + leistung + 'W';
        log_warn(grund);

    // PV moderat schwächer → Basisleistung
    } else if (pvVerhaeltnis !== null && pvVerhaeltnis < PV_VERH_GUT) {
        leistung = basisLeistung;
        grund    = 'PV moderat unter Prognose (' + (pvVerhaeltnis * 100).toFixed(0) + '%) → Basisleistung ' + leistung + 'W';
        log_info(grund);

    // Viel PV prognostiziert UND alles im Plan → sanft laden
    } else if (tagesPrognose !== null && tagesPrognose >= PV_PROGNOSE_HOCH) {
        leistung = Math.max(basisLeistung, LEISTUNG_SANFT);
        grund    = 'Viel PV (' + (tagesPrognose / 1000).toFixed(0) + ' kWh Tagesprognose) + im Plan → sanft ' + leistung + 'W';
        log_info(grund);

    // Alles normal → Basisleistung
    } else {
        leistung = basisLeistung;
        grund    = 'Normalbetrieb → Basisleistung ' + leistung + 'W';
        log_info(grund);
    }

    basisLeistungVorigeStunde = basisLeistung;
    schreibeLeistung(leistung, grund);
});

log_info('Skript gestartet | DRY_RUN=' + DRY_RUN + ' | Aktiv: ' + START_STUNDE + ':00–' + END_STUNDE + ':00 Uhr | Ziel: ' + ZIEL_SOC + '% bis ' + ZIEL_UHRZEIT + ':00 Uhr');

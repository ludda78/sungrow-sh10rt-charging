// ============================================================
// Sungrow SH10RT – Adaptive Ladesteuerung
// Version: 1.1.2
// Modus: DRY_RUN = true → kein Schreiben, nur Logging
// ============================================================
//
// CHANGELOG
// ---------
// v1.1.2 – 2026-05-14
//   - Einspeisebegrenzungs-Monitor: stufenweise Erhöhung statt Sprung auf MAX
//     Jede Minute +EINSPEISUNG_SCHRITT (1000W) solange Einspeisung über Schwelle
//     Gibt WR/Batterie Zeit zu reagieren bevor nächste Stufe folgt
//
// v1.1.1 – 2026-05-14
//   - Einspeisebegrenzungs-Monitor: neuer Minutentakt (8–17 Uhr)
//     liest alias.0.Elektro.Zaehler.power; wenn Einspeisung das Limit
//     minus Puffer überschreitet → sofort MAX_LEISTUNG setzen
//     Neue Parameter: EINSPEISUNG_LIMIT, EINSPEISUNG_PUFFER, DP_NETZ
//
// v1.1.0 – 2026-05-14
//   - Vereinfachung: 3-stufige Forecast-Logik → 2-stufig
//     PV_PROGNOSE_NIEDRIG + PV_PROGNOSE_HOCH + LEISTUNG_SANFT entfernt
//     Neu: PV_PROGNOSE_SCHWELLE = 45 kWh
//     < 45 kWh → MAX | ≥ 45 kWh → Basisleistung
//
// v1.0.9 – 2026-05-14
//   - PV-Alarm kombiniert jetzt historischen Ratio MIT Forward-looking Coverage:
//     Ratio < 70% löst MAX nur aus wenn Deckungsgrad (pvNochWh/fehlendeWh) < 1.5×
//     Verhindert Fehlalarme bei kleinen frühmorgendlichen Stichproben
//   - Neuer Parameter PV_DECKUNG_MIN (Standard: 1.5)
//   - Log zeigt Deckungsgrad bei jeder PV-Prüfung
//
// v1.0.8 – 2026-05-13
//   - Endladephase: wenn Basisleistung < MIN_LEISTUNG, Release MAX statt
//     auf MIN zu clampen → WR übernimmt CV-Phase und regelt Trickle selbst
//
// v1.0.7 – 2026-05-13
//   - Logikfehler: kumulierter Rückstand war Einwegzähler (nur +), ignorierte
//     Überschuss-Stunden. Jetzt Netto-Saldo: Mehrladung reduziert Rückstand wieder.
//     Log zeigt signed Differenz (+ = Rückstand, - = Vorsprung)
//
// v1.0.6 – 2026-05-12
//   - Dreistufige Forecast-Logik: neuer Parameter PV_PROGNOSE_NIEDRIG (35 kWh)
//     Forecast < 35 kWh → sofort MAX_LEISTUNG (schlechter Tag, jede kWh zählt)
//     Forecast 35–40 kWh → Basisleistung | Forecast > 40 kWh → sanft
//
// v1.0.5 – 2026-05-09
//   - DRY_RUN deaktiviert → Livebetrieb
//   - Neue Datenpunkte: javascript.0.ladesteuerung.schreibzyklen (täglich)
//     und schreibzyklen_gesamt (kumulativ); Log zeigt Zählstand je Schreibvorgang
//
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

var DRY_RUN         = false;   // true = Testmodus, kein Schreiben ins Register

var ZIEL_UHRZEIT    = 16;      // Uhr – Batterie soll bis dahin voll sein
var ZIEL_SOC        = 100;     // % – Ziel-Ladestand
var BATTERIE_KWH    = 9.6;     // kWh – nutzbare Kapazität SBR096
var MAX_LEISTUNG    = 6570;    // W – maximale Ladeleistung, wr kann bis 10,6kWh
var MIN_LEISTUNG    = 500;     // W – Minimum (verhindert Abbruch des Ladevorgangs)
var START_STUNDE    = 8;       // Uhr – Steuerung aktiv ab (erste Stunde dient als Referenz für SOC-Rückstand)
var END_STUNDE      = 17;      // Uhr – Steuerung aktiv bis (letzte adaptive Entscheidung um END_STUNDE-1 Uhr)

// PV-Prognose Schwellwert: unter diesem Wert immer MAX laden
var PV_PROGNOSE_SCHWELLE = 45000; // Wh – < 45 kWh → MAX | ≥ 45 kWh → Basisleistung

// SOC-Rückstand Schwellen (kumuliert über den Tag)
var RUECKSTAND_MODERAT  = 5;  // % – Leistung um 50% erhöhen
var RUECKSTAND_KRITISCH = 10; // % – sofort auf MAX_LEISTUNG

// PV-Verhältnis Schwellen (tatsächlich / prognostiziert)
var PV_VERH_GUT     = 0.9;    // über 90% → Plan hält
var PV_VERH_MODERAT = 0.7;    // 70–90% → etwas erhöhen
                               // unter 70% → MAX, aber nur wenn Deckungsgrad auch knapp

// Mindest-Deckungsgrad: pvNochWh / fehlendeWh – PV-Alarm greift nur wenn Forecast
// den Restbedarf nicht mehr ausreichend abdeckt (verhindert Fehlalarme bei kleinen Samples)
var PV_DECKUNG_MIN  = 1.5;    // Forecast muss mind. 1.5× den Batteriebedarf decken

// Einspeisebegrenzungs-Monitor (Minutentakt)
var EINSPEISUNG_LIMIT  = 6000; // W – konfigurierte Einspeisebegrenzung (Betrag)
var EINSPEISUNG_PUFFER =  500; // W – Abstand zur Grenze, ab dem erhöht wird (Trigger bei -5500W)
var EINSPEISUNG_SCHRITT= 1000; // W – Erhöhung pro Minute solange Einspeisung über Schwelle

// ============================================================
// DATENPUNKTE
// ============================================================

var DP_SOC          = 'modbus.0.inputRegisters.13022_Battery_level_';
var DP_PV_HEUTE     = 'modbus.0.inputRegisters.13001_Daily_PV_Generation';   // kWh
var DP_PV_PROGNOSE  = 'pvforecast.0.summary.energy.nowUntilEndOfDay';        // Wh – noch zu erwarten
var DP_PV_NOW       = 'pvforecast.0.summary.energy.now';                     // Wh – heute laut Prognose bereits erzeugt
var DP_NETZ              = 'alias.0.Elektro.Zaehler.power';                         // W – negativ = Einspeisung ins Netz
var DP_HR_LADEN          = 'modbus.0.holdingRegisters.33046_Max_Charging_Power';  // W
var DP_SCHREIBZYKLEN     = 'javascript.0.ladesteuerung.schreibzyklen';            // Schreibvorgänge heute
var DP_SCHREIBZYKLEN_GES = 'javascript.0.ladesteuerung.schreibzyklen_gesamt';     // Schreibvorgänge gesamt

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
        var zyklenHeute   = (getState(DP_SCHREIBZYKLEN).val     || 0) + 1;
        var zyklenGesamt  = (getState(DP_SCHREIBZYKLEN_GES).val || 0) + 1;
        setState(DP_SCHREIBZYKLEN,     zyklenHeute);
        setState(DP_SCHREIBZYKLEN_GES, zyklenGesamt);
        log_info('Geschrieben: ' + leistung + 'W (vorher: ' + letzterWert + 'W) | ' + grund +
                 ' | Schreibzyklus #' + zyklenHeute + ' heute / ' + zyklenGesamt + ' gesamt');
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
        setState(DP_SCHREIBZYKLEN, 0);
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
    var restStunden   = Math.max(0, ZIEL_UHRZEIT - stunde);
    var basisLeistung = berechneBasisleistung(soc, restStunden);
    var fehlendeWh    = Math.max(0, ZIEL_SOC - soc) / 100 * BATTERIE_KWH * 1000;
    var pvDeckungsgrad = fehlendeWh > 0 ? pvNochWh / fehlendeWh : 999;

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

    // --- Endladephase: Basisleistung unter Minimum → WR übernimmt CV-Phase ---
    if (basisLeistung < MIN_LEISTUNG) {
        log_info('Endladephase – Basisleistung ' + basisLeistung + 'W < MIN_LEISTUNG → WR regelt Endladung selbst');
        basisLeistungVorigeStunde = basisLeistung;
        socVorEinerStunde = soc;
        schreibeLeistung(MAX_LEISTUNG, 'Endladephase (Basisleistung ' + basisLeistung + 'W < ' + MIN_LEISTUNG + 'W) → WR übernimmt');
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

    log_info('PV-Verhältnis: ' + pvVerhaeltnisText +
             ' | Deckungsgrad: ' + pvDeckungsgrad.toFixed(1) + '× (' +
             (pvNochWh / 1000).toFixed(1) + ' kWh Prognose / ' +
             (fehlendeWh / 1000).toFixed(1) + ' kWh Bedarf)');

    // -------------------------------------------------------
    // ENTSCHEIDUNG 2: SOC-Rückstand prüfen
    // -------------------------------------------------------
    if (socVorEinerStunde !== null && basisLeistungVorigeStunde !== null) {
        var socAnstiegIst         = soc - socVorEinerStunde;
        var socAnstiegErwartet    = Math.round(basisLeistungVorigeStunde / 1000 / BATTERIE_KWH * 100);
        var differenzDieseStunde  = Math.round((socAnstiegErwartet - socAnstiegIst) * 10) / 10;
        kumulierterRueckstand     = Math.max(0, kumulierterRueckstand + differenzDieseStunde);

        log_info('SOC-Anstieg: erwartet ' + socAnstiegErwartet + '% / tatsächlich ' + socAnstiegIst.toFixed(1) + '% | ' +
                 'Differenz: ' + (differenzDieseStunde > 0 ? '+' : '') + differenzDieseStunde.toFixed(1) + '% | ' +
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

    // PV deutlich schlechter als erwartet UND Forecast deckt Bedarf nicht mehr → Maximum
    } else if (pvVerhaeltnis !== null && pvVerhaeltnis < PV_VERH_MODERAT && pvDeckungsgrad < PV_DECKUNG_MIN) {
        leistung = MAX_LEISTUNG;
        grund    = 'PV unter Prognose (' + (pvVerhaeltnis * 100).toFixed(0) + '%) + Deckungsgrad ' +
                   pvDeckungsgrad.toFixed(1) + '× < ' + PV_DECKUNG_MIN + '× → sofort ' + MAX_LEISTUNG + 'W';
        log_warn(grund);

    // PV deutlich schlechter, aber Forecast deckt Bedarf noch → Basisleistung
    } else if (pvVerhaeltnis !== null && pvVerhaeltnis < PV_VERH_MODERAT) {
        leistung = basisLeistung;
        grund    = 'PV unter Prognose (' + (pvVerhaeltnis * 100).toFixed(0) + '%) aber Deckungsgrad ' +
                   pvDeckungsgrad.toFixed(1) + '× ≥ ' + PV_DECKUNG_MIN + '× → Basisleistung ' + leistung + 'W';
        log_info(grund);

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

    // Forecast unter Schwelle → MAX (unsicherer Tag, jede kWh zählt)
    } else if (tagesPrognose !== null && tagesPrognose < PV_PROGNOSE_SCHWELLE) {
        leistung = MAX_LEISTUNG;
        grund    = 'Forecast ' + (tagesPrognose / 1000).toFixed(0) + ' kWh < ' + (PV_PROGNOSE_SCHWELLE / 1000) + ' kWh → sofort ' + MAX_LEISTUNG + 'W';
        log_warn(grund);

    // Guter Tag → Basisleistung (adaptiv)
    } else {
        leistung = basisLeistung;
        grund    = 'Guter Tag (' + (tagesPrognose !== null ? (tagesPrognose / 1000).toFixed(0) : '?') + ' kWh) → Basisleistung ' + leistung + 'W';
        log_info(grund);
    }

    basisLeistungVorigeStunde = basisLeistung;
    schreibeLeistung(leistung, grund);
});

// ============================================================
// EINSPEISEBEGRENZUNGS-MONITOR – läuft jede Minute
// ============================================================

schedule('* 8-17 * * *', function() {
    var stunde = new Date().getHours();
    if (stunde < START_STUNDE || stunde >= END_STUNDE) return;

    // Bereits auf MAX – stündliche Logik normalisiert bei nächstem Durchlauf
    if (letzterWert === MAX_LEISTUNG) return;
    // Kein vorheriger Wert – stündliche Logik macht ersten Schreibvorgang
    if (letzterWert === null) return;

    var netz = getState(DP_NETZ).val;
    if (netz === null) return;

    var schwelle = -(EINSPEISUNG_LIMIT - EINSPEISUNG_PUFFER); // z.B. -5500W
    if (netz < schwelle) {
        var einspWatt = Math.abs(netz);
        var neueLeistung = letzterWert + EINSPEISUNG_SCHRITT;
        log_warn('Einspeisung ' + (einspWatt / 1000).toFixed(1) + ' kW ≥ Schwelle ' +
                 ((EINSPEISUNG_LIMIT - EINSPEISUNG_PUFFER) / 1000).toFixed(1) +
                 ' kW → +' + EINSPEISUNG_SCHRITT + 'W auf ' + Math.min(neueLeistung, MAX_LEISTUNG) + 'W');
        schreibeLeistung(neueLeistung, 'Einspeisebegrenzung (' + (einspWatt / 1000).toFixed(1) + ' kW / ' + (EINSPEISUNG_LIMIT / 1000) + ' kW Limit)');
    }
});

createState('ladesteuerung.schreibzyklen',     0, false, { name: 'Ladesteuerung – Schreibzyklen heute',  type: 'number', role: 'value', unit: '' });
createState('ladesteuerung.schreibzyklen_gesamt', 0, false, { name: 'Ladesteuerung – Schreibzyklen gesamt', type: 'number', role: 'value', unit: '' });

log_info('Skript gestartet | DRY_RUN=' + DRY_RUN + ' | Aktiv: ' + START_STUNDE + ':00–' + END_STUNDE + ':00 Uhr | Ziel: ' + ZIEL_SOC + '% bis ' + ZIEL_UHRZEIT + ':00 Uhr');

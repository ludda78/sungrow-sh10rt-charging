// ============================================================
// Sungrow SH10RT – Adaptive Ladesteuerung
// Version: 1.2.1
// Modus: DRY_RUN = true → kein Schreiben, nur Logging
// ============================================================
//
// CHANGELOG
// ---------
// v1.2.1 – 2026-10-07
//   - Modbus-Watchdog: Modbus läuft jetzt über einen Proxy auf dem Raspi 5.
//     Vor dem Switch-Neustart wird geprüft, ob der Proxy per TCP erreichbar ist.
//     Proxy/Raspi nicht erreichbar → kein Switch-Neustart, nur Telegram-Meldung;
//     Prüfung läuft weiter und startet den Switch neu, falls der Proxy wieder da ist
//     und trotzdem keine Daten kommen
//     Neue Parameter: MODBUS_PROXY_HOST, MODBUS_PROXY_PORT
//
// v1.2.0 – 2026-10-04
//   - Modbus-Watchdog (Minutentakt, rund um die Uhr): erkennt Verbindungsverlust zum
//     Sungrow am Alter der Modbus-Daten (neuester Zeitstempel aller Input-Register)
//     Nach MODBUS_FEHLCHECKS Prüfungen in Folge: Netzwerk-Switch per Shelly aus/ein
//     + Telegram-Meldung; max. MODBUS_RESET_MAX Versuche, danach Meldung „manuell prüfen"
//     Telegram-Entwarnung sobald wieder Daten kommen
//     Neue Parameter: MODBUS_WATCHDOG, MODBUS_TIMEOUT_SEK, MODBUS_FEHLCHECKS,
//     MODBUS_RESET_MAX, MODBUS_RESET_PAUSE_SEK, SHELLY_AUS_SEK, DP_NETZWERK_SCHALTER
//   - Fix: stündliche Prüfung rechnete bei Verbindungsverlust mit dem letzten bekannten
//     SOC weiter. Jetzt: veraltete Modbus-Daten → keine Berechnung, kein Schreiben,
//     Telegram-Meldung; SOC-Rückstands-Referenz wird verworfen
//   - Einspeise-Monitor + Telegram-Button schreiben nicht mehr bei veralteten Daten
//   - EINSPEISUNG_LIMIT 6000 → 7000 W: Einspeisebegrenzung im Wechselrichter wurde über
//     die Weboberfläche des WiNet-S angehoben; Monitor greift jetzt ab 6500 W Einspeisung
//
// v1.1.9 – 2026-08-08
//   - Neuer Parameter PROGNOSE_FAKTOR (Standard: 1.10):
//     Korrigiert systematische Unterschätzung des Forecast-Adapters (+10–20%)
//     Wird auf pvNochWh, pvNowWh und tagesPrognose angewendet (nicht auf Echtmesswerte)
//     → Deckungsgrad und PV-Verhältnis werden realistischer
//     → PV_PROGNOSE_SCHWELLE-Vergleich trifft bessere Entscheidungen
//     Log zeigt korrigierte Werte (×PROGNOSE_FAKTOR) beim Tagesstart
//   - Neuer Parameter PV_DECKUNG_KOMFORT (Standard: 3.0×):
//     Wenn Deckungsgrad ≥ 3× wird KRITISCHER SOC-Rückstand (≥ 10%) nur noch
//     moderat beantwortet (Basisleistung × 1.5 statt MAX_LEISTUNG)
//     Verhindert unnötigen MAX-Sprung an Sonnentagen mit großem Verbraucher
//     MAX greift nur noch wenn Deckungsgrad < PV_DECKUNG_KOMFORT (Forecast wirklich knapp)
//   - Einspeisebegrenzungs-Monitor + Telegram Button: SOC-Prüfung vor Schreibzyklus
//     Wenn Akku bereits voll (SOC ≥ ZIEL_SOC): kein Register-Schreibzyklus
//     Stattdessen Info-Nachricht „Akku voll, Verbraucher zuschalten" via Telegram
//     Folgeauslöser und Button-Anfragen werden bei vollem Akku ebenfalls unterdrückt
//
// v1.1.6 – 2026-05-23
//   - tagesPrognose liest jetzt pvforecast.0.summary.energy.today direkt
//     (Tagesstart + Neustart-Fallback); keine Nachrechnung mehr nötig
//     Neuer Datenpunkt: DP_PV_TODAY
//
// v1.1.4 – 2026-05-23
//   - Einspeisebegrenzungs-Monitor: klar getrennter 2-Stufen-Ablauf
//     1. Auslöser/Stunde: automatisch +1000W, nur Info-Meldung (kein Button)
//     Folgeauslöser gleicher Stunde: Button-Anfrage in Telegram (nicht auto)
//     Kein doppelter Button wenn Antwort noch aussteht (einspeisungButtonPending)
//     Stündlicher Reset durch Neuberechnung der Hauptlogik
//
// v1.1.3 – 2026-05-23
//   - Einspeisebegrenzungs-Monitor: 10-Minuten-Takt statt Minutentakt
//     Pro Prüfung max. ein Schritt (+1000W); gibt WR Zeit zu reagieren
//   - Telegram-Integration: bei Auto-Schritt kommt Nachricht mit Button
//     "+1000W" für weitere manuelle Erhöhung, Kette beliebig oft wiederholbar
//     Neue Parameter: TELEGRAM_INSTANZ
//
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
var PV_DECKUNG_MIN    = 1.5;  // Forecast muss mind. 1.5× den Batteriebedarf decken
var PV_DECKUNG_KOMFORT = 3.0; // Bei Deckungsgrad ≥ 3×: KRITISCHER SOC-Rückstand wird nur moderat beantwortet (× 1.5 statt MAX)

// Systematischer Korrekturfaktor für Prognose-Unterschätzung des Forecast-Adapters
// Empirisch: tatsächlicher Ertrag liegt typisch 10–20% über Prognose
// Wird auf pvNochWh, pvNowWh und tagesPrognose angewendet (nicht auf Echtmesswerte)
var PROGNOSE_FAKTOR   = 1.10; // 1.0 = keine Korrektur | 1.10 = +10% | 1.15 = +15%

// Einspeisebegrenzungs-Monitor (alle 10 Minuten, +1 Stufe pro Prüfung)
var EINSPEISUNG_MONITOR  = true;  // true = Monitor aktiv
// EINSPEISUNG_LIMIT muss zur Einspeisebegrenzung im Wechselrichter passen. Die lässt sich
// über die Weboberfläche des WiNet-S ändern (2026-10: dort von 6000 auf 7000 W angehoben).
var EINSPEISUNG_LIMIT    = 7000;  // W – konfigurierte Einspeisebegrenzung (Betrag)
var EINSPEISUNG_PUFFER   =  500;  // W – Abstand zur Grenze, ab dem erhöht wird (Trigger bei -6500W)
var EINSPEISUNG_SCHRITT  = 1000;  // W – Erhöhung pro automatischem Schritt (und pro Telegram-Button)
var TELEGRAM_INSTANZ     = 'telegram.1';

// Modbus-Watchdog (jede Minute, rund um die Uhr)
var MODBUS_WATCHDOG        = true; // true = Watchdog aktiv
var MODBUS_TIMEOUT_SEK     = 120;  // s – Modbus-Daten älter als das gelten als veraltet
var MODBUS_FEHLCHECKS      = 2;    // Prüfungen in Folge mit veralteten Daten, bevor der Switch neu gestartet wird
var MODBUS_RESET_MAX       = 3;    // max. Neustart-Versuche pro Störung, danach nur noch Meldung
var MODBUS_RESET_PAUSE_SEK = 300;  // s – Wartezeit nach einem Neustart bis zum nächsten Versuch
var SHELLY_AUS_SEK         = 10;   // s – so lange bleibt der Switch stromlos
// Modbus läuft über einen Proxy auf dem Raspi 5: ist der Proxy selbst nicht erreichbar,
// wird der Switch NICHT neu gestartet (nur Meldung). Leer = keine Proxy-Prüfung.
var MODBUS_PROXY_HOST      = '192.168.178.105'; // IP des Raspi 5 mit dem Modbus-Proxy
var MODBUS_PROXY_PORT      = 502;               // Port des Modbus-Proxys

// ============================================================
// DATENPUNKTE
// ============================================================

var DP_SOC          = 'modbus.0.inputRegisters.13022_Battery_level_';
var DP_PV_HEUTE     = 'modbus.0.inputRegisters.13001_Daily_PV_Generation';   // kWh
var DP_PV_PROGNOSE  = 'pvforecast.0.summary.energy.nowUntilEndOfDay';        // Wh – noch zu erwarten
var DP_PV_NOW       = 'pvforecast.0.summary.energy.now';                     // Wh – heute laut Prognose bereits erzeugt
var DP_PV_TODAY     = 'pvforecast.0.summary.energy.today';                   // Wh – Tagesprognose gesamt
var DP_NETZ              = 'alias.0.Elektro.Zaehler.power';                         // W – negativ = Einspeisung ins Netz
var DP_HR_LADEN          = 'modbus.0.holdingRegisters.33046_Max_Charging_Power';  // W
var DP_SCHREIBZYKLEN     = 'javascript.0.ladesteuerung.schreibzyklen';            // Schreibvorgänge heute
var DP_SCHREIBZYKLEN_GES = 'javascript.0.ladesteuerung.schreibzyklen_gesamt';     // Schreibvorgänge gesamt
var MODBUS_INSTANZ       = 'modbus.0';
var DP_MODBUS_DATEN      = MODBUS_INSTANZ + '.inputRegisters.*';                  // Muster – neuester Zeitstempel = letzte Antwort des WR
var DP_NETZWERK_SCHALTER = 'shelly.0.shellyplugsg3#d885ac135a64#1.Relay0.Switch'; // Shelly Plug am Netzwerk-Switch (true/false) | leer = nur Meldung, kein Neustart

// ============================================================
// ZUSTAND (wird zur Laufzeit gehalten)
// ============================================================

var letzterWert              = null;   // zuletzt geschriebene Ladeleistung (W)
var socVorEinerStunde        = null;   // SOC-Wert der letzten Stunde
var basisLeistungVorigeStunde = null;  // Basisleistung der Vorperiode (Referenz für SOC-Anstieg)
var kumulierterRueckstand    = 0;      // % – Summe der SOC-Rückstände über den Tag
var tagesPrognose            = null;   // Wh – Prognose gesamt (wird um START_STUNDE gesetzt)
var einspeisungLetzteAutoStunde = -1; // Stunde in der der Auto-Schritt bereits ausgeführt wurde
var einspeisungButtonPending    = false; // true = Telegram-Button gesendet, warte auf Antwort
var modbusFehlChecks         = 0;      // Watchdog-Prüfungen in Folge mit veralteten Daten
var modbusResetVersuche      = 0;      // Switch-Neustarts in der laufenden Störung
var modbusNaechsterResetAb   = 0;      // Zeitstempel (ms) – vorher kein weiterer Neustart
var modbusStoerungGemeldet   = false;  // true = Störung wurde per Telegram gemeldet (→ Entwarnung senden)
var modbusAufgabeGemeldet    = false;  // true = „kein (weiterer) Neustart möglich" wurde gemeldet
var modbusProxyGemeldet      = false;  // true = „Proxy nicht erreichbar" wurde gemeldet

// ============================================================
// HILFSFUNKTIONEN
// ============================================================

function log_info(msg) {
    log('[Ladesteuerung] ' + msg, 'info');
}

function log_warn(msg) {
    log('[Ladesteuerung] ⚠️  ' + msg, 'warn');
}

function telegram(text) {
    sendTo(TELEGRAM_INSTANZ, 'send', { text: text });
}

// Alter der Modbus-Daten in Sekunden (null = keine Datenpunkte gefunden).
// Einzelne Register wie der SOC ändern sich stundenlang nicht, deshalb zählt
// der neueste Zeitstempel über alle Input-Register.
function modbusDatenAlterSek() {
    var neuesterTs = 0;
    $('state[id=' + DP_MODBUS_DATEN + ']').each(function(id) {
        var st = getState(id);
        if (st && st.ts > neuesterTs) neuesterTs = st.ts;
    });
    if (neuesterTs === 0) return null;
    return (Date.now() - neuesterTs) / 1000;
}

function modbusDatenAktuell() {
    var alter = modbusDatenAlterSek();
    return alter !== null && alter <= MODBUS_TIMEOUT_SEK;
}

function alterText(alterSek) {
    if (alterSek === null) return 'unbekannt';
    if (alterSek < 5400)   return Math.round(alterSek / 60) + ' min';
    return (alterSek / 3600).toFixed(1) + ' h';
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
        tagesPrognose              = getState(DP_PV_TODAY).val * PROGNOSE_FAKTOR;
        kumulierterRueckstand      = 0;
        socVorEinerStunde          = null;
        basisLeistungVorigeStunde  = null;
        setState(DP_SCHREIBZYKLEN, 0);
        log_info('Tagesstart – Tagesprognose gesamt: ' + (tagesPrognose / 1000).toFixed(1) + ' kWh (×' + PROGNOSE_FAKTOR + ')');
    }

    // --- Modbus-Daten veraltet → nicht mit dem letzten bekannten SOC weiterrechnen ---
    var datenAlterSek = modbusDatenAlterSek();
    if (datenAlterSek === null || datenAlterSek > MODBUS_TIMEOUT_SEK) {
        var socAlt = getState(DP_SOC).val;
        log_warn('Keine aktuellen Modbus-Daten (letzte Daten vor ' + alterText(datenAlterSek) +
                 ', letzter bekannter SOC ' + socAlt + '%) → keine Berechnung, kein Schreiben');
        telegram('⚠️ Ladesteuerung ' + stunde + ':02 Uhr: keine aktuellen Daten vom Sungrow (letzte Daten vor ' +
                 alterText(datenAlterSek) + ', letzter bekannter SOC ' + socAlt + '%). Prüfung übersprungen, Ladeleistung bleibt unverändert.');
        socVorEinerStunde         = null;
        basisLeistungVorigeStunde = null;
        return;
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
    var pvNowWh     = getState(DP_PV_NOW).val      * PROGNOSE_FAKTOR; // Wh – Prognose für bereits vergangene Zeit (korrigiert)
    var pvNochWh    = getState(DP_PV_PROGNOSE).val * PROGNOSE_FAKTOR; // Wh – noch zu erwarten heute (korrigiert)
    var restStunden   = Math.max(0, ZIEL_UHRZEIT - stunde);
    var basisLeistung = berechneBasisleistung(soc, restStunden);
    var fehlendeWh    = Math.max(0, ZIEL_SOC - soc) / 100 * BATTERIE_KWH * 1000;
    var pvDeckungsgrad = fehlendeWh > 0 ? pvNochWh / fehlendeWh : 999;

    // Fallback nach Neustart: Tagesprognose direkt aus Datenpunkt lesen
    if (tagesPrognose === null) {
        tagesPrognose = getState(DP_PV_TODAY).val * PROGNOSE_FAKTOR;
        log_info('Tagesprognose nach Neustart gesetzt: ' + (tagesPrognose / 1000).toFixed(1) + ' kWh (×' + PROGNOSE_FAKTOR + ')');
    }

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

    // Kritischer SOC-Rückstand → MAX, außer Forecast deckt Bedarf sehr komfortabel
    if (kumulierterRueckstand >= RUECKSTAND_KRITISCH) {
        if (pvDeckungsgrad >= PV_DECKUNG_KOMFORT) {
            leistung = Math.round(basisLeistung * 1.5);
            grund    = 'SOC-Rückstand kritisch (' + kumulierterRueckstand.toFixed(1) + '%) aber Deckungsgrad ' +
                       pvDeckungsgrad.toFixed(1) + '× ≥ ' + PV_DECKUNG_KOMFORT + '× → moderat Basisleistung × 1.5 = ' + leistung + 'W';
            log_warn(grund);
        } else {
            leistung = MAX_LEISTUNG;
            grund    = 'KRITISCHER SOC-Rückstand (' + kumulierterRueckstand.toFixed(1) + '% kumuliert) + Deckungsgrad ' +
                       pvDeckungsgrad.toFixed(1) + '× < ' + PV_DECKUNG_KOMFORT + '× → sofort ' + MAX_LEISTUNG + 'W';
            log_warn(grund);
        }

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

schedule('*/10 8-17 * * *', function() {
    if (!EINSPEISUNG_MONITOR) return;
    var stunde = new Date().getHours();
    if (stunde < START_STUNDE || stunde >= END_STUNDE) return;
    if (letzterWert === null) return;        // warten bis stündliche Logik erstmals geschrieben hat
    if (letzterWert === MAX_LEISTUNG) return; // bereits auf MAX

    // Neue Stunde → Button-Status zurücksetzen (stündliche Logik hat Leistung neu gesetzt)
    if (stunde !== einspeisungLetzteAutoStunde) {
        einspeisungButtonPending = false;
    }

    var netz = getState(DP_NETZ).val;
    if (netz === null) return;

    var schwelle = -(EINSPEISUNG_LIMIT - EINSPEISUNG_PUFFER);
    if (netz >= schwelle) return; // Einspeisung noch im grünen Bereich
    if (!modbusDatenAktuell()) return; // keine Verbindung zum WR → SOC unbekannt, Schreiben zwecklos

    var einspWatt    = Math.abs(netz);
    var neueLeistung = letzterWert + EINSPEISUNG_SCHRITT;
    var zielWatt     = Math.min(neueLeistung, MAX_LEISTUNG);
    var socAktuell   = getState(DP_SOC).val;
    var akkuVoll     = (socAktuell >= ZIEL_SOC);

    if (stunde !== einspeisungLetzteAutoStunde) {
        einspeisungLetzteAutoStunde = stunde;
        if (akkuVoll) {
            // Akku voll → nur Info, kein Schreibzyklus
            log_info('Einspeisung ' + (einspWatt / 1000).toFixed(1) + ' kW – Akku voll (' + socAktuell + '%), kein Schreibzyklus');
            sendTo(TELEGRAM_INSTANZ, 'send', {
                text: '⚡ Einspeisung ' + (einspWatt / 1000).toFixed(1) + ' kW – Akku bereits voll (' + socAktuell + '%). Bitte Verbraucher zuschalten.'
            });
        } else {
            // Erster Auslöser dieser Stunde → automatisch erhöhen, nur Info-Meldung
            log_warn('Einspeisung ' + (einspWatt / 1000).toFixed(1) + ' kW → Auto-Schritt +' + EINSPEISUNG_SCHRITT + 'W auf ' + zielWatt + 'W');
            schreibeLeistung(neueLeistung, 'Einspeisebegrenzung Auto (' + (einspWatt / 1000).toFixed(1) + ' kW / ' + (EINSPEISUNG_LIMIT / 1000) + ' kW Limit)');
            sendTo(TELEGRAM_INSTANZ, 'send', {
                text: '⚡ Einspeisung ' + (einspWatt / 1000).toFixed(1) + ' kW – Ladeleistung automatisch auf ' + zielWatt + 'W erhöht.'
            });
        }

    } else if (!einspeisungButtonPending && !akkuVoll) {
        // Folgeauslöser diese Stunde → per Button anfragen, nicht automatisch erhöhen
        einspeisungButtonPending = true;
        sendTo(TELEGRAM_INSTANZ, 'send', {
            text: '⚡ Einspeisung noch ' + (einspWatt / 1000).toFixed(1) + ' kW – Ladeleistung weiter auf ' + zielWatt + 'W erhöhen?',
            reply_markup: JSON.stringify({
                inline_keyboard: [[
                    { text: '✅ +' + (EINSPEISUNG_SCHRITT / 1000) + ' kW', callback_data: 'einsp_boost' },
                    { text: '❌ Nein',                                       callback_data: 'einsp_nein'  }
                ]]
            })
        });
    }
    // else: Button noch ausstehend oder Akku voll → nicht erneut fragen
});

// Telegram Inline-Button Handler
// Adapter speichert Button-Klicks in .communicate.request als "[Nutzer]callback_data"
on({ id: TELEGRAM_INSTANZ + '.communicate.request', change: 'ne' }, function(obj) {
    var raw = obj.state.val;
    if (!raw) return;

    // Format: "[Martin]einsp_boost" → callback_data extrahieren
    var cbData = raw;
    var match = raw.match(/^\[.*?\](.+)$/);
    if (match) cbData = match[1].trim();

    // Nur eigene Callbacks verarbeiten, alles andere ignorieren
    if (cbData !== 'einsp_boost' && cbData !== 'einsp_nein') return;

    log_info('Telegram Button: ' + cbData);
    einspeisungButtonPending = false;

    if (cbData === 'einsp_boost') {
        if (letzterWert === null || letzterWert >= MAX_LEISTUNG) {
            sendTo(TELEGRAM_INSTANZ, 'send', { text: '⚠️ Bereits bei MAX_LEISTUNG, keine weitere Erhöhung möglich.' });
            return;
        }
        if (!modbusDatenAktuell()) {
            telegram('⚠️ Keine aktuellen Daten vom Sungrow – Erhöhung nicht möglich.');
            return;
        }
        var socBtn = getState(DP_SOC).val;
        if (socBtn >= ZIEL_SOC) {
            sendTo(TELEGRAM_INSTANZ, 'send', { text: '⚠️ Akku bereits voll (' + socBtn + '%), kein Schreibzyklus nötig. Bitte Verbraucher zuschalten.' });
            return;
        }
        var neueLeistung = letzterWert + EINSPEISUNG_SCHRITT;
        var zielWatt     = Math.min(neueLeistung, MAX_LEISTUNG);
        schreibeLeistung(neueLeistung, 'Manueller Boost via Telegram');

        if (zielWatt < MAX_LEISTUNG) {
            einspeisungButtonPending = true;
            sendTo(TELEGRAM_INSTANZ, 'send', {
                text: '✅ Ladeleistung auf ' + zielWatt + 'W erhöht. Noch einen Schritt?',
                reply_markup: JSON.stringify({
                    inline_keyboard: [[
                        { text: '✅ +' + (EINSPEISUNG_SCHRITT / 1000) + ' kW', callback_data: 'einsp_boost' },
                        { text: '❌ Nein',                                       callback_data: 'einsp_nein'  }
                    ]]
                })
            });
        } else {
            sendTo(TELEGRAM_INSTANZ, 'send', { text: '✅ Ladeleistung auf MAX (' + zielWatt + 'W) erhöht.' });
        }

    } else if (cbData === 'einsp_nein') {
        sendTo(TELEGRAM_INSTANZ, 'send', { text: 'OK, keine weitere Erhöhung.' });
    }
});

// ============================================================
// MODBUS-WATCHDOG – läuft jede Minute, rund um die Uhr
// ============================================================

// Prüft per TCP-Verbindungsaufbau, ob ein Dienst antwortet – callback(true/false)
function tcpErreichbar(host, port, callback) {
    var fertig = false;
    var sock   = require('net').connect({ host: host, port: port });
    function ende(ok) {
        if (fertig) return;
        fertig = true;
        sock.destroy();
        callback(ok);
    }
    sock.setTimeout(3000, function() { ende(false); });
    sock.on('connect', function() { ende(true); });
    sock.on('error',   function() { ende(false); });
}

function netzwerkSwitchNeustart() {
    setState(DP_NETZWERK_SCHALTER, false);
    setTimeout(function() {
        setState(DP_NETZWERK_SCHALTER, true);
        // Kontrolle: Switch darf auf keinen Fall aus bleiben
        setTimeout(function() {
            if (getState(DP_NETZWERK_SCHALTER).val !== true) {
                log_warn('Netzwerk-Switch nach Neustart nicht wieder eingeschaltet – zweiter Versuch');
                setState(DP_NETZWERK_SCHALTER, true);
                telegram('🚨 Netzwerk-Switch (Shelly) meldet nach dem Neustart nicht „ein" – bitte prüfen!');
            }
        }, 15000);
    }, SHELLY_AUS_SEK * 1000);
}

schedule('* * * * *', function() {
    if (!MODBUS_WATCHDOG) return;

    var alterSek = modbusDatenAlterSek();
    if (alterSek === null) {
        if (!modbusAufgabeGemeldet) {
            modbusAufgabeGemeldet = true;
            log_warn('Modbus-Watchdog: keine Datenpunkte unter ' + DP_MODBUS_DATEN + ' gefunden – Watchdog ohne Funktion');
        }
        return;
    }

    // --- Daten aktuell → ggf. Entwarnung, Zustand zurücksetzen ---
    if (alterSek <= MODBUS_TIMEOUT_SEK) {
        if (modbusStoerungGemeldet) {
            log_info('Modbus-Watchdog: Sungrow liefert wieder Daten (nach ' + modbusResetVersuche + ' Switch-Neustart(s))');
            telegram('✅ Sungrow liefert wieder Daten (nach ' + modbusResetVersuche + ' Switch-Neustart(s)).');
        }
        modbusFehlChecks       = 0;
        modbusResetVersuche    = 0;
        modbusNaechsterResetAb = 0;
        modbusStoerungGemeldet = false;
        modbusAufgabeGemeldet  = false;
        modbusProxyGemeldet    = false;
        return;
    }

    // --- Daten veraltet ---
    modbusFehlChecks++;
    if (modbusFehlChecks < MODBUS_FEHLCHECKS) return;   // erst bei wiederholtem Befund reagieren
    if (Date.now() < modbusNaechsterResetAb) return;    // letzter Neustart braucht noch Zeit
    if (modbusAufgabeGemeldet) return;                  // nichts mehr zu tun, Meldung ist raus

    var stoerung = 'Sungrow: seit ' + alterText(alterSek) + ' keine Modbus-Daten';

    // Adapter gestoppt → Switch-Neustart hilft nicht
    var adapterAlive = getState('system.adapter.' + MODBUS_INSTANZ + '.alive').val;
    if (adapterAlive === false) {
        modbusAufgabeGemeldet  = true;
        modbusStoerungGemeldet = true;
        log_warn('Modbus-Watchdog: ' + stoerung + ' – Adapter ' + MODBUS_INSTANZ + ' läuft nicht, kein Switch-Neustart');
        telegram('⚠️ ' + stoerung + ' – der Adapter ' + MODBUS_INSTANZ + ' läuft nicht. Kein Switch-Neustart, bitte Adapter prüfen.');
        return;
    }

    // Ohne Proxy-Prüfung direkt zum Switch-Neustart
    if (!MODBUS_PROXY_HOST) {
        modbusSwitchNeustartVersuch(stoerung);
        return;
    }

    // Proxy/Pi ausgefallen → Switch-Neustart hilft nicht und würde nur das Netz unterbrechen
    tcpErreichbar(MODBUS_PROXY_HOST, MODBUS_PROXY_PORT, function(erreichbar) {
        if (erreichbar) {
            modbusProxyGemeldet = false;
            modbusSwitchNeustartVersuch(stoerung);
            return;
        }
        if (modbusProxyGemeldet) return; // Meldung ist raus, weiter jede Minute prüfen
        modbusProxyGemeldet    = true;
        modbusStoerungGemeldet = true;
        log_warn('Modbus-Watchdog: ' + stoerung + ' – Modbus-Proxy ' + MODBUS_PROXY_HOST + ':' + MODBUS_PROXY_PORT +
                 ' nicht erreichbar, kein Switch-Neustart');
        telegram('⚠️ ' + stoerung + ' – der Modbus-Proxy ' + MODBUS_PROXY_HOST + ':' + MODBUS_PROXY_PORT +
                 ' ist nicht erreichbar. Kein Switch-Neustart, bitte Proxy/Raspi prüfen.');
    });
});

function modbusSwitchNeustartVersuch(stoerung) {
    if (!DP_NETZWERK_SCHALTER || !existsState(DP_NETZWERK_SCHALTER)) {
        modbusAufgabeGemeldet  = true;
        modbusStoerungGemeldet = true;
        log_warn('Modbus-Watchdog: ' + stoerung + ' – DP_NETZWERK_SCHALTER nicht konfiguriert/gefunden, kein Neustart möglich');
        telegram('⚠️ ' + stoerung + '. Automatischer Switch-Neustart nicht eingerichtet – bitte manuell aus-/einschalten.');
        return;
    }

    if (modbusResetVersuche >= MODBUS_RESET_MAX) {
        modbusAufgabeGemeldet = true;
        log_warn('Modbus-Watchdog: ' + stoerung + ' – ' + modbusResetVersuche + ' Switch-Neustarts ohne Erfolg, gebe auf');
        telegram('🚨 ' + stoerung + '. ' + modbusResetVersuche + ' Switch-Neustarts ohne Erfolg – bitte manuell prüfen!');
        return;
    }

    modbusResetVersuche++;
    modbusNaechsterResetAb = Date.now() + MODBUS_RESET_PAUSE_SEK * 1000;
    modbusStoerungGemeldet = true;
    log_warn('Modbus-Watchdog: ' + stoerung + ' → Netzwerk-Switch-Neustart (Versuch ' + modbusResetVersuche + '/' + MODBUS_RESET_MAX + ')');
    telegram('⚠️ ' + stoerung + ' → Netzwerk-Switch wird neu gestartet (Versuch ' + modbusResetVersuche + '/' + MODBUS_RESET_MAX + ').');
    netzwerkSwitchNeustart();
}

createState('ladesteuerung.schreibzyklen',     0, false, { name: 'Ladesteuerung – Schreibzyklen heute',  type: 'number', role: 'value', unit: '' });
createState('ladesteuerung.schreibzyklen_gesamt', 0, false, { name: 'Ladesteuerung – Schreibzyklen gesamt', type: 'number', role: 'value', unit: '' });

log_info('Skript gestartet | DRY_RUN=' + DRY_RUN + ' | Aktiv: ' + START_STUNDE + ':00–' + END_STUNDE + ':00 Uhr | Ziel: ' + ZIEL_SOC + '% bis ' + ZIEL_UHRZEIT + ':00 Uhr');

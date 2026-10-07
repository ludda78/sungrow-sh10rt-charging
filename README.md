# Sungrow SH10RT – Adaptive Ladesteuerung

ioBroker JavaScript-Skript zur adaptiven Steuerung der maximalen Ladeleistung eines Sungrow SH10RT Hybrid-Wechselrichters. Die Batterie wird gleichmäßig über den Tag verteilt geladen und soll bis zu einem konfigurierbaren Zielzeitpunkt (Standard: **16:00 Uhr**) auf **100% SOC** gebracht werden. Bei schlechtem Wetter oder Laderückstand wird die Leistung automatisch erhöht.

> **Hinweis:** Das Skript läuft produktiv an meiner eigenen Anlage. Die Werte im Repo sind auf diese Anlage abgestimmt, und `DRY_RUN` steht auf `false`. Wer es übernimmt, sollte zuerst den Abschnitt [Vor dem ersten Start anpassen](#vor-dem-ersten-start-anpassen) durchgehen.

## Was das Skript macht

| Baustein | Takt | Aufgabe | Abschaltbar |
|----------|------|---------|-------------|
| **Ladesteuerung** | stündlich um :02, 8–17 Uhr | berechnet die maximale Ladeleistung und schreibt sie ins Register | nein (Kern) |
| **Einspeise-Monitor** | alle 10 Minuten, 8–17 Uhr | erhöht die Ladeleistung, wenn die Einspeisung an die Einspeisebegrenzung stößt | `EINSPEISUNG_MONITOR = false` |
| **Modbus-Watchdog** | jede Minute, rund um die Uhr | erkennt Verbindungsverlust zum Wechselrichter, startet den Netzwerk-Switch per Shelly neu | `MODBUS_WATCHDOG = false` |

Meldungen und Rückfragen laufen über Telegram.

## Voraussetzungen

- ioBroker **JavaScript Adapter** ≥ 6.x
- ioBroker **Modbus Adapter** – Sungrow SH10RT per LAN/Modbus TCP eingebunden
- ioBroker **pvforecast Adapter** – mit Solcast oder forecast.solar konfiguriert
- ioBroker **Telegram Adapter** – das Skript sendet an die Instanz aus `TELEGRAM_INSTANZ` (im Repo `telegram.1`). Es gibt keinen Schalter, um Telegram abzuschalten; ohne Adapter erscheinen Warnungen im Protokoll und die Meldungen gehen verloren.
- Sungrow SH10RT mit Modbus TCP Zugriff
- Sungrow SBR096 Batterie (9,6 kWh) – oder `BATTERIE_KWH` anpassen

Nur für die optionalen Bausteine:

- **Einspeise-Monitor:** ein Datenpunkt mit der aktuellen Netzleistung in W, negativ = Einspeisung (`DP_NETZ`)
- **Watchdog mit Switch-Neustart:** ein schaltbarer Datenpunkt für die Steckdose am Netzwerk-Switch, z.B. ein Shelly Plug über den Shelly Adapter (`DP_NETZWERK_SCHALTER`)

## Vor dem ersten Start anpassen

1. `DRY_RUN = true` setzen – das Skript schreibt dann nichts ins Register und loggt nur.
2. Anlagenwerte eintragen: `BATTERIE_KWH`, `MAX_LEISTUNG`, `PV_PROGNOSE_SCHWELLE` (siehe [Konfiguration](#konfiguration)).
3. Alle `DP_*`-Datenpunkte auf die eigene Modbus-Instanz und die eigenen Registernamen prüfen.
4. `TELEGRAM_INSTANZ` auf die eigene Instanz setzen.
5. Bausteine abschalten, die nicht zur eigenen Anlage passen:
   - kein Zähler-Datenpunkt oder keine Einspeisebegrenzung → `EINSPEISUNG_MONITOR = false`
   - kein schaltbarer Netzwerk-Switch → `DP_NETZWERK_SCHALTER = ''` (der Watchdog meldet dann nur per Telegram)
   - kein Modbus-Proxy → `MODBUS_PROXY_HOST = ''`
   - gar keine Überwachung gewünscht → `MODBUS_WATCHDOG = false`

Die Erkennung veralteter Modbus-Daten in der Ladesteuerung bleibt in jedem Fall aktiv (siehe [Verhalten bei Verbindungsverlust](#verhalten-bei-verbindungsverlust)).

## Ladesteuerung

Das Skript läuft **stündlich um :02** (pvforecast aktualisiert bei :00:30) und entscheidet, welche maximale Ladeleistung ins Modbus Holding Register geschrieben wird.

### Steuerungsgrößen

1. **Basisleistung** – rechnerische Mindestleistung, um das Ziel pünktlich zu erreichen
   `(fehlende kWh bis 100%) / (Stunden bis Zielzeit) × 1000`

2. **PV-Verhältnis** – tatsächliche Erzeugung heute im Vergleich zur Prognose bis jetzt
   Wird erst ausgewertet, wenn die Prognose bis jetzt über 0,5 kWh liegt.

3. **Deckungsgrad** – verbleibende Prognose geteilt durch den noch fehlenden Batteriebedarf
   Verhindert Fehlalarme bei kleinen Stichproben am Morgen.

4. **Kumulierter SOC-Rückstand** – Nettosaldo der stündlichen Abweichungen zwischen erwartetem SOC-Anstieg (aus der Basisleistung der Vorstunde) und tatsächlichem Anstieg. Mehrladung baut den Rückstand wieder ab.

5. **Tagesprognose** – Gesamtprognose für den Tag aus `pvforecast.0.summary.energy.today`

Alle Prognosewerte werden mit `PROGNOSE_FAKTOR` multipliziert (im Repo 1,10), weil der Forecast-Adapter an meiner Anlage systematisch zu niedrig liegt. Messwerte bleiben unverändert.

### Entscheidungsreihenfolge

Die erste zutreffende Bedingung gewinnt:

| # | Bedingung | Ladeleistung |
|---|-----------|--------------|
| 1 | Ziel-SOC erreicht | MAX (Wechselrichter regelt selbst) |
| 2 | Zieluhrzeit überschritten | MAX |
| 3 | Basisleistung < `MIN_LEISTUNG` (Endladephase) | MAX (Wechselrichter regelt die Endladung selbst) |
| 4 | SOC-Rückstand ≥ 10% und Deckungsgrad < 3× | MAX |
| 5 | SOC-Rückstand ≥ 10% und Deckungsgrad ≥ 3× | Basisleistung × 1,5 |
| 6 | PV-Verhältnis < 70% und Deckungsgrad < 1,5× | MAX |
| 7 | PV-Verhältnis < 70% und Deckungsgrad ≥ 1,5× | Basisleistung |
| 8 | SOC-Rückstand ≥ 5% | Basisleistung × 1,5 |
| 9 | PV-Verhältnis < 90% | Basisleistung |
| 10 | Tagesprognose < 45 kWh | MAX (unsicherer Tag, jede kWh zählt) |
| 11 | sonst (guter Tag) | Basisleistung |

Die Leistung wird auf 100 W gerundet, auf `MIN_LEISTUNG`…`MAX_LEISTUNG` begrenzt und nur geschrieben, wenn sie sich um mehr als 100 W ändert. Um 17:02 Uhr wird MAX freigegeben; bis zum nächsten Morgen regelt der Wechselrichter selbst.

## Einspeise-Monitor

Für Anlagen mit Einspeisebegrenzung: Lädt die Batterie gedrosselt und die Einspeisung stößt an die Grenze, würde PV-Leistung abgeregelt. Der Monitor erhöht dann die Ladeleistung.

- **Auslöser:** Einspeisung über `EINSPEISUNG_LIMIT − EINSPEISUNG_PUFFER` (im Repo 6500 W)
- **Erster Auslöser der Stunde:** Ladeleistung automatisch um `EINSPEISUNG_SCHRITT` erhöhen, Info per Telegram
- **Weitere Auslöser derselben Stunde:** Rückfrage per Telegram mit Buttons „+1 kW“ / „Nein“
- **Akku bereits voll:** keine Erhöhung, nur der Hinweis, Verbraucher zuzuschalten

`EINSPEISUNG_LIMIT` muss zur Einspeisebegrenzung im Wechselrichter passen. Die lässt sich über die Weboberfläche des WiNet-S ändern.

## Modbus-Watchdog

Der Watchdog erkennt einen Verbindungsverlust am Alter der Modbus-Daten: Er nimmt den neuesten Zeitstempel aller Datenpunkte unter `modbus.0.inputRegisters.*`. Einzelne Register wie der SOC ändern sich stundenlang nicht, und `info.connection` springt bei Verbindungsfehlern hin und her – beides taugt nicht als Signal.

Ablauf, wenn die Daten älter als `MODBUS_TIMEOUT_SEK` sind und das bei `MODBUS_FEHLCHECKS` Prüfungen in Folge:

1. Läuft der Modbus-Adapter nicht → nur Telegram-Meldung, kein Neustart.
2. Ist `MODBUS_PROXY_HOST` gesetzt und der Proxy per TCP nicht erreichbar → nur Telegram-Meldung, kein Neustart. Die Prüfung läuft jede Minute weiter.
3. Sonst: Steckdose am Netzwerk-Switch aus, `SHELLY_AUS_SEK` warten, wieder ein, danach Kontrolle, ob sie wirklich „ein“ meldet. Telegram-Meldung bei jedem Versuch.
4. Höchstens `MODBUS_RESET_MAX` Versuche mit `MODBUS_RESET_PAUSE_SEK` Abstand, danach die Meldung „bitte manuell prüfen“.
5. Sobald wieder Daten kommen: Entwarnung per Telegram.

Hintergrund zum Proxy: Der SH10RT erlaubt nur eine Modbus-TCP-Verbindung. Wer mehrere Clients hat (z.B. ioBroker und evcc), braucht einen Modbus-Proxy davor. Fällt der Proxy aus, kommen ebenfalls keine Daten, obwohl Wechselrichter und Switch in Ordnung sind – ein Switch-Neustart würde dann nichts bringen.

Der Watchdog setzt voraus, dass sich mindestens ein Input-Register innerhalb von `MODBUS_TIMEOUT_SEK` ändert. Meldet er nachts fälschlich einen Ausfall, `MODBUS_TIMEOUT_SEK` erhöhen oder im Modbus-Adapter das Aktualisieren unveränderter Werte aktivieren.

## Verhalten bei Verbindungsverlust

Sind die Modbus-Daten veraltet, rechnet die Ladesteuerung **nicht** mit dem letzten bekannten SOC weiter:

- Die stündliche Prüfung wird übersprungen, es wird nichts geschrieben, und es kommt eine Telegram-Meldung mit Datenalter und letztem bekannten SOC.
- Die Referenz für den SOC-Rückstand wird verworfen, damit die Stunde nach dem Ausfall nicht gegen einen alten Wert verglichen wird.
- Einspeise-Monitor und Telegram-Button schreiben ebenfalls nicht.

Das gilt unabhängig davon, ob der Watchdog eingeschaltet ist.

## Datenpunkte

| Variable | Datenpunkt im Repo | Richtung | Beschreibung |
|----------|--------------------|----------|--------------|
| `DP_SOC` | `modbus.0.inputRegisters.13022_Battery_level_` | Lesen | SOC in % |
| `DP_PV_HEUTE` | `modbus.0.inputRegisters.13001_Daily_PV_Generation` | Lesen | PV-Erzeugung heute (kWh) |
| `DP_PV_NOW` | `pvforecast.0.summary.energy.now` | Lesen | Prognose bis jetzt (Wh) |
| `DP_PV_PROGNOSE` | `pvforecast.0.summary.energy.nowUntilEndOfDay` | Lesen | Prognose noch heute (Wh) |
| `DP_PV_TODAY` | `pvforecast.0.summary.energy.today` | Lesen | Tagesprognose gesamt (Wh) |
| `DP_NETZ` | `alias.0.Elektro.Zaehler.power` | Lesen | Netzleistung (W), negativ = Einspeisung |
| `DP_HR_LADEN` | `modbus.0.holdingRegisters.33046_Max_Charging_Power` | **Schreiben** | Maximale Ladeleistung (W) |
| `DP_MODBUS_DATEN` | `modbus.0.inputRegisters.*` | Lesen | Muster für die Altersprüfung der Modbus-Daten |
| `DP_NETZWERK_SCHALTER` | Shelly Plug, `…Relay0.Switch` | **Schreiben** | Steckdose am Netzwerk-Switch (true/false) |
| `DP_SCHREIBZYKLEN` | `javascript.0.ladesteuerung.schreibzyklen` | Schreiben | Schreibvorgänge heute (legt das Skript selbst an) |
| `DP_SCHREIBZYKLEN_GES` | `javascript.0.ladesteuerung.schreibzyklen_gesamt` | Schreiben | Schreibvorgänge gesamt (legt das Skript selbst an) |

## Einrichtung

### 1. Skript in ioBroker anlegen

Skript `ladesteuerung.js` im ioBroker JavaScript Adapter als neues Skript anlegen und speichern.

### 2. Anpassen

Die Punkte aus [Vor dem ersten Start anpassen](#vor-dem-ersten-start-anpassen) durchgehen.

### 3. Trockenlauf (empfohlen: 1–2 Tage)

```javascript
var DRY_RUN = true; // kein Schreiben ins Register
```

Logs im ioBroker Admin unter **Protokoll** beobachten (Filter: `Ladesteuerung`). Prüfen, ob die gelesenen Werte und berechneten Leistungen plausibel sind.

`DRY_RUN` betrifft nur das Schreiben der Ladeleistung. Der Watchdog schaltet den Netzwerk-Switch auch im Trockenlauf.

### 4. Scharfschalten

```javascript
var DRY_RUN = false;
```

Skript neu starten – ab jetzt wird das Register beschrieben.

## Konfiguration

Alle Parameter stehen im Abschnitt `KONFIGURATION` am Anfang des Skripts. Die Werte in der Spalte „Im Repo“ gehören zu meiner Anlage.

### Ladesteuerung

| Parameter | Im Repo | Beschreibung |
|-----------|---------|--------------|
| `DRY_RUN` | `false` | Testmodus – kein Schreiben ins Register |
| `ZIEL_UHRZEIT` | `16` | Zielzeit für vollen Akku (Stunde) |
| `ZIEL_SOC` | `100` | Ziel-Ladestand in % |
| `BATTERIE_KWH` | `9.6` | Nutzbare Kapazität in kWh |
| `MAX_LEISTUNG` | `6570` | Maximale Ladeleistung in W |
| `MIN_LEISTUNG` | `500` | Minimale Ladeleistung in W |
| `START_STUNDE` | `8` | Steuerung aktiv ab (Uhr) |
| `END_STUNDE` | `17` | Steuerung aktiv bis (Uhr) |
| `PV_PROGNOSE_SCHWELLE` | `45000` | Tagesprognose in Wh – darunter immer MAX_LEISTUNG |
| `RUECKSTAND_MODERAT` | `5` | SOC-Rückstand % → Leistung × 1,5 |
| `RUECKSTAND_KRITISCH` | `10` | SOC-Rückstand % → MAX_LEISTUNG |
| `PV_VERH_GUT` | `0.9` | PV-Verhältnis, ab dem der Plan als gut gilt |
| `PV_VERH_MODERAT` | `0.7` | PV-Verhältnis, unterhalb dem MAX erwogen wird |
| `PV_DECKUNG_MIN` | `1.5` | Deckungsgrad, unter dem ein schlechtes PV-Verhältnis zu MAX führt |
| `PV_DECKUNG_KOMFORT` | `3.0` | Deckungsgrad, ab dem ein kritischer SOC-Rückstand nur mit × 1,5 beantwortet wird |
| `PROGNOSE_FAKTOR` | `1.10` | Korrekturfaktor für alle Prognosewerte (1.0 = keine Korrektur) |

`PV_PROGNOSE_SCHWELLE` hängt stark von der Anlagengröße ab. Meine Anlage erzeugt an guten Tagen rund 60 kWh.

### Einspeise-Monitor und Telegram

| Parameter | Im Repo | Beschreibung |
|-----------|---------|--------------|
| `EINSPEISUNG_MONITOR` | `true` | Monitor ein/aus |
| `EINSPEISUNG_LIMIT` | `7000` | Einspeisebegrenzung des Wechselrichters in W |
| `EINSPEISUNG_PUFFER` | `500` | Abstand zur Grenze in W, ab dem erhöht wird |
| `EINSPEISUNG_SCHRITT` | `1000` | Erhöhung pro Schritt in W |
| `TELEGRAM_INSTANZ` | `telegram.1` | Telegram-Instanz für alle Meldungen |

### Modbus-Watchdog

| Parameter | Im Repo | Beschreibung |
|-----------|---------|--------------|
| `MODBUS_WATCHDOG` | `true` | Watchdog ein/aus |
| `MODBUS_TIMEOUT_SEK` | `120` | Ab diesem Alter in Sekunden gelten Modbus-Daten als veraltet (gilt auch für die Ladesteuerung) |
| `MODBUS_FEHLCHECKS` | `2` | Prüfungen in Folge, bevor der Switch neu gestartet wird |
| `MODBUS_RESET_MAX` | `3` | Maximale Neustart-Versuche pro Störung |
| `MODBUS_RESET_PAUSE_SEK` | `300` | Wartezeit zwischen zwei Versuchen in Sekunden |
| `SHELLY_AUS_SEK` | `10` | So lange bleibt der Switch stromlos |
| `MODBUS_PROXY_HOST` | IP meines Proxys | Modbus-Proxy; leer = keine Proxy-Prüfung |
| `MODBUS_PROXY_PORT` | `502` | Port des Modbus-Proxys |

## Logging

Alle Ausgaben beginnen mit `[Ladesteuerung]` und erscheinen im ioBroker Protokoll.

```
[Ladesteuerung] === Stündliche Prüfung | 11:02:00 ===
[Ladesteuerung] SOC: 42% | PV heute: 3.2 kWh | PV Prognose noch: 28.4 kWh | Reststunden bis 16 Uhr: 5.0h | Basisleistung: 1114W
[Ladesteuerung] PV-Verhältnis: 88% (real 3.2 kWh / erwartet 3.6 kWh) | Deckungsgrad: 5.1× (28.4 kWh Prognose / 5.6 kWh Bedarf)
[Ladesteuerung] SOC-Anstieg: erwartet 11% / tatsächlich 9.5% | Differenz: +1.5% | Kumulierter Rückstand: 1.5%
[Ladesteuerung] PV moderat unter Prognose (88%) → Basisleistung 1114W
[Ladesteuerung] Geschrieben: 1100W (vorher: 1300W) | PV moderat unter Prognose (88%) → Basisleistung 1114W | Schreibzyklus #3 heute / 412 gesamt
```

Bei einem Verbindungsverlust:

```
[Ladesteuerung] ⚠️  Keine aktuellen Modbus-Daten (letzte Daten vor 14 min, letzter bekannter SOC 64.9%) → keine Berechnung, kein Schreiben
[Ladesteuerung] ⚠️  Modbus-Watchdog: Sungrow: seit 3 min keine Modbus-Daten → Netzwerk-Switch-Neustart (Versuch 1/3)
[Ladesteuerung] Modbus-Watchdog: Sungrow liefert wieder Daten (nach 1 Switch-Neustart(s))
```

## Bekannte Einschränkungen

- Der kumulierte SOC-Rückstand wird bei einem Skript-Neustart auf 0 zurückgesetzt. Die Tagesprognose wird nach einem Neustart neu eingelesen.
- Wetteränderungen werden nur stündlich berücksichtigt.
- Fällt die Verbindung um 17:02 Uhr aus, wird die Freigabe auf MAX übersprungen. Das Register bleibt dann bis zur nächsten Prüfung um 8:02 Uhr auf dem letzten Wert.
- Hängt der Modbus-Proxy, nimmt aber noch Verbindungen an, hält der Watchdog das für einen Ausfall des Wechselrichters und startet den Switch neu.
- Der Zustand liegt nur im Arbeitsspeicher des Skripts, nichts wird dauerhaft gespeichert.

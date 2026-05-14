# Sungrow SH10RT – Adaptive Ladesteuerung

ioBroker JavaScript-Skript zur adaptiven Steuerung der maximalen Ladeleistung eines Sungrow SH10RT Hybrid-Wechselrichters. Die Batterie wird gleichmäßig über den Tag verteilt geladen und soll bis zu einem konfigurierbaren Zielzeitpunkt (Standard: **16:00 Uhr**) auf **100% SOC** gebracht werden. Bei schlechtem Wetter oder Laderückstand wird die Leistung automatisch erhöht.

## Voraussetzungen

- ioBroker **JavaScript Adapter** ≥ 6.x
- ioBroker **Modbus Adapter** – Sungrow SH10RT per LAN/Modbus TCP eingebunden
- ioBroker **pvforecast Adapter** – mit Solcast oder forecast.solar konfiguriert
- Sungrow SH10RT-20 mit Modbus TCP Zugriff
- Sungrow SBR096 Batterie (9,6 kWh) – oder `BATTERIE_KWH` anpassen

## Funktionsweise

Das Skript läuft **stündlich um :02** (pvforecast aktualisiert bei :00:30) und entscheidet anhand von drei Steuerungsgrößen, welche maximale Ladeleistung ins Modbus Holding Register geschrieben wird:

1. **Basisleistung** – rechnerische Mindestleistung um das Ziel pünktlich zu erreichen  
   `(fehlende kWh bis 100%) / (Stunden bis Zielzeit) × 1000`

2. **PV-Verhältnis** – Vergleich tatsächliche Erzeugung vs. Prognose bis jetzt  
   `< 70%` → MAX (aber nur wenn Deckungsgrad < 1.5×) | `70–90%` → Basisleistung | `> 90%` → Plan beibehalten  
   **Deckungsgrad** = verbleibender Forecast / noch benötigte kWh – verhindert Fehlalarme bei kleinen Morgenstichproben

3. **Kumulierter SOC-Rückstand** – Nettosaldo der stündlichen Abweichungen zwischen erwartetem SOC-Anstieg (basierend auf Basisleistung der Vorperiode) und tatsächlichem Anstieg  
   `> 10%` → sofort MAX | `5–10%` → Basisleistung × 1,5

4. **Forecast-Schwelle** – Tagesprognose bestimmt Grundverhalten  
   `< 45 kWh` → sofort MAX (unsicherer Tag, jede kWh zählt) | `≥ 45 kWh` → Basisleistung (adaptiv)

Außerhalb des aktiven Zeitfensters (08:00–17:00 Uhr) wird MAX_LEISTUNG freigegeben und der Wechselrichter regelt selbst.

## Datenpunkte

| Datenpunkt | Richtung | Beschreibung |
|------------|----------|--------------|
| `modbus.0.inputRegisters.13022_Battery_level_` | Lesen | SOC in % |
| `modbus.0.inputRegisters.13001_Daily_PV_Generation` | Lesen | PV-Erzeugung heute (kWh) |
| `pvforecast.0.summary.energy.now` | Lesen | Prognose bis jetzt (Wh) |
| `pvforecast.0.summary.energy.nowUntilEndOfDay` | Lesen | Prognose noch heute (Wh) |
| `modbus.0.holdingRegisters.33046_Max_Charging_Power` | **Schreiben** | Maximale Ladeleistung (W) |

## Einrichtung

### 1. Skript in ioBroker anlegen

Skript `ladesteuerung.js` im ioBroker JavaScript Adapter als neues Skript anlegen und speichern.

### 2. Datenpunkte prüfen

Sicherstellen, dass alle `DP_*`-Variablen am Anfang des Skripts auf die eigenen Modbus-Instanz- und Registernummern passen.

### 3. Trockenlauf (empfohlen: 1–2 Tage)

```javascript
var DRY_RUN = true; // Standard – kein Schreiben ins Register
```

Logs im ioBroker Admin unter **Protokoll** beobachten (Filter: `Ladesteuerung`). Prüfen ob die gelesenen Werte und berechneten Leistungen plausibel sind.

### 4. Scharfschalten

```javascript
var DRY_RUN = false;
```

Skript neu starten – ab jetzt wird das Register beschrieben.

## Konfiguration

Alle Parameter stehen im Abschnitt `KONFIGURATION` am Anfang des Skripts:

| Parameter | Aktuell | Beschreibung |
|-----------|---------|--------------|
| `DRY_RUN` | `false` | Testmodus – kein Schreiben |
| `ZIEL_UHRZEIT` | `16` | Zielzeit für vollen Akku (Stunde) |
| `ZIEL_SOC` | `100` | Ziel-Ladestand in % |
| `BATTERIE_KWH` | `9.6` | Nutzbare Kapazität in kWh |
| `MAX_LEISTUNG` | `6570` | Maximale Ladeleistung in W |
| `MIN_LEISTUNG` | `500` | Minimale Ladeleistung in W |
| `START_STUNDE` | `8` | Steuerung aktiv ab (Uhr) |
| `END_STUNDE` | `17` | Steuerung aktiv bis (Uhr) |
| `PV_PROGNOSE_SCHWELLE` | `45000` | Schwellwert in Wh – darunter immer MAX_LEISTUNG |
| `RUECKSTAND_MODERAT` | `5` | SOC-Rückstand % → Leistung × 1,5 |
| `RUECKSTAND_KRITISCH` | `10` | SOC-Rückstand % → sofort MAX_LEISTUNG |
| `PV_VERH_GUT` | `0.9` | PV-Verhältnis ab dem Plan als gut gilt |
| `PV_VERH_MODERAT` | `0.7` | PV-Verhältnis unterhalb dem MAX erwogen wird |
| `PV_DECKUNG_MIN` | `1.5` | Mindest-Deckungsgrad (Forecast/Bedarf) für PV-Alarm |

## Logging

Alle Ausgaben beginnen mit `[Ladesteuerung]` und erscheinen im ioBroker Protokoll.

```
[Ladesteuerung] === Stündliche Prüfung | 11:02:00 ===
[Ladesteuerung] SOC: 42% | PV heute: 3.2 kWh | PV Prognose noch: 28.4 kWh | Reststunden bis 16 Uhr: 5.0h | Basisleistung: 1044W
[Ladesteuerung] PV-Verhältnis: 88% (real 3.2 kWh / erwartet 3.6 kWh)
[Ladesteuerung] SOC-Anstieg: erwartet 11% / tatsächlich 9.5% | Rückstand diese Stunde: 1.5% | Kumulierter Rückstand: 1.5%
[Ladesteuerung] Geschrieben: 1000W (vorher: 1100W) | PV moderat unter Prognose...
```

## Bekannte Einschränkungen

- Kumulierter SOC-Rückstand und Tagesprognose werden bei Skript-Neustart zurückgesetzt
- Wetteränderungen werden nur stündlich berücksichtigt
- Tagesprognose wird einmalig um START_STUNDE gesetzt – Neustart danach setzt sie auf `null` bis zum nächsten Tag

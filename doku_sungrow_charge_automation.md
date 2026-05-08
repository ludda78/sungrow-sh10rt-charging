# Sungrow SH10RT – Adaptive Ladesteuerung

**Version:** 1.0.0  
**Plattform:** ioBroker JavaScript Adapter  
**Wechselrichter:** Sungrow SH10RT-20  
**Batterie:** Sungrow SBR096 (9,6 kWh)

---

## Ziel

Die Batterie soll an sonnigen Tagen möglichst schonend und gleichmäßig über den Tag verteilt geladen werden – mit dem obersten Ziel, bis **15:00 Uhr auf 100% SOC** zu kommen. Bei schlechter PV-Ausbeute oder Rückstand wird die Ladeleistung automatisch erhöht.

---

## Funktionsweise

Das Skript läuft **einmal pro Stunde** (zur vollen Stunde) und entscheidet anhand von drei Steuerungsgrößen, welche maximale Ladeleistung ins Modbus Holding Register geschrieben wird.

### Zeitfenster

| Zeitraum | Verhalten |
|----------|-----------|
| Vor 09:00 Uhr | 6000W freigegeben (WR und Batterie regeln selbst) |
| 09:00–17:00 Uhr | Adaptive Steuerung aktiv |
| Nach 17:00 Uhr | 6000W freigegeben |

### Steuerungsgrößen

#### 1. Basisleistung

Die Mindestleistung die rechnerisch nötig ist, um das Ziel pünktlich zu erreichen:

```
Basisleistung = (fehlende kWh bis 100%) / (Stunden bis 15:00) × 1000
```

**Beispiele:**

| Uhrzeit | SOC | Fehlende kWh | Reststunden | Basisleistung |
|---------|-----|-------------|-------------|---------------|
| 09:00 | 20% | 7,68 kWh | 6,0 h | 1280 W |
| 11:00 | 40% | 5,76 kWh | 4,0 h | 1440 W |
| 13:00 | 55% | 4,32 kWh | 2,0 h | 2160 W |
| 14:00 | 60% | 3,84 kWh | 1,0 h | 3840 W |
| 14:00 | 30% | 6,72 kWh | 1,0 h | 6000 W (Notfall) |

#### 2. PV-Verhältnis

Stündlicher Vergleich: tatsächliche Erzeugung vs. was laut Prognose bis jetzt hätte erzeugt werden sollen.

```
PV-Verhältnis = pv_energy_today (Wh) / pvforecast.energy.now (Wh)
```

| Verhältnis | Bedeutung | Reaktion |
|------------|-----------|----------|
| > 90% | Prognose stimmt | Plan beibehalten |
| 70–90% | Etwas schwächer | Basisleistung verwenden |
| < 70% | Deutlich schlechter | Sofort 6000W |

#### 3. SOC-Rückstand (kumuliert)

Jede Stunde wird verglichen wie viel der SOC gestiegen ist vs. was bei der eingestellten Ladeleistung zu erwarten gewesen wäre. Die Abweichungen werden über den Tag aufsummiert.

```
Erwarteter SOC-Anstieg = Ladeleistung (kW) / 9,6 kWh × 100
Rückstand = max(0, erwartet - tatsächlich)
Kumulierter Rückstand += Rückstand dieser Stunde
```

**Beispiel:**

| Stunde | Leistung | Erw. SOC+ | Ist SOC+ | Rückstand | Kumuliert |
|--------|----------|-----------|----------|-----------|-----------|
| 10:00 | 1500 W | 15,6% | 14,0% | 1,6% | 1,6% |
| 11:00 | 1500 W | 15,6% | 8,0% | 7,6% | 9,2% |
| 12:00 | – | – | – | – | → **KRITISCH** |

| Kumulierter Rückstand | Reaktion |
|----------------------|----------|
| < 5% | Nichts tun |
| 5–10% | Basisleistung × 1,5 |
| > 10% | Sofort 6000W |

### Entscheidungsreihenfolge

Die Priorität ist von oben nach unten:

1. **SOC bereits 100%** → MAX freigeben, WR regelt selbst
2. **Zeit überschritten (nach 15:00)** → MAX freigeben
3. **Kumulierter Rückstand > 10%** → sofort 6000W
4. **PV-Verhältnis < 70%** → sofort 6000W
5. **Kumulierter Rückstand 5–10%** → Basisleistung × 1,5
6. **PV-Verhältnis 70–90%** → Basisleistung
7. **Viel PV (Tagesprognose > 50 kWh) + alles im Plan** → max(Basisleistung, 1500W)
8. **Normalbetrieb** → Basisleistung

### Schreibschutz

Das Register wird nur beschrieben wenn sich der Wert um mehr als 100W geändert hat. Alle Werte werden auf 100W gerundet. Das reduziert unnötige Schreibvorgänge auf typisch 5–15 pro Tag.

---

## Datenpunkte

| Variable | Datenpunkt | Einheit | Beschreibung |
|----------|-----------|---------|--------------|
| SOC | `modbus.0.inputRegisters.13022_Battery_level_` | % | Aktueller Ladestand |
| PV heute | `modbus.0.inputRegisters.13001_Daily_PV_Generation` | kWh | Tatsächliche Erzeugung heute |
| PV Prognose noch | `pvforecast.0.summary.energy.nowUntilEndOfDay` | Wh | Noch zu erwartende PV heute |
| PV Prognose bis jetzt | `pvforecast.0.summary.energy.now` | Wh | Was laut Prognose bis jetzt hätte erzeugt werden sollen |
| Ladeleistung | `modbus.0.holdingRegisters.33046_Max_Charging_Power` | W | Maximale Ladeleistung (Holding Register) |

---

## Konfiguration

Alle Parameter stehen am Anfang des Skripts im Abschnitt `KONFIGURATION`:

| Parameter | Standard | Beschreibung |
|-----------|---------|--------------|
| `DRY_RUN` | `true` | Testmodus – kein Schreiben ins Register |
| `ZIEL_UHRZEIT` | `15` | Zielzeit für vollen Akku |
| `ZIEL_SOC` | `100` | Ziel-Ladestand in % |
| `BATTERIE_KWH` | `9.6` | Nutzbare Kapazität in kWh |
| `MAX_LEISTUNG` | `6000` | Maximale Ladeleistung in W |
| `MIN_LEISTUNG` | `500` | Minimale Ladeleistung in W |
| `START_STUNDE` | `9` | Steuerung aktiv ab (Uhr) |
| `END_STUNDE` | `17` | Steuerung aktiv bis (Uhr) |
| `PV_PROGNOSE_HOCH` | `50000` | Schwellwert "viel PV" in Wh |
| `LEISTUNG_SANFT` | `1500` | Leistung bei viel Sonne und Plan OK |
| `RUECKSTAND_MODERAT` | `5` | SOC-Rückstand % → Leistung × 1,5 |
| `RUECKSTAND_KRITISCH` | `10` | SOC-Rückstand % → sofort 6000W |
| `PV_VERH_GUT` | `0.9` | PV-Verhältnis ab dem Plan als "gut" gilt |
| `PV_VERH_MODERAT` | `0.7` | PV-Verhältnis ab dem sofort 6000W |

---

## Inbetriebnahme

### Schritt 1: Trockenlauf (1–2 Tage)

```javascript
var DRY_RUN = true;
```

Das Skript läuft durch und loggt alle Entscheidungen, schreibt aber **nichts** ins Register. Logs im ioBroker Admin unter **Protokoll** beobachten.

### Schritt 2: Logs auswerten

Alle Log-Einträge beginnen mit `[Ladesteuerung]`. Prüfen:
- Sind die gelesenen Werte plausibel (SOC, PV-Werte)?
- Sind die berechneten Leistungen sinnvoll?
- Werden Warnungen (`⚠️`) korrekt ausgelöst?

### Schritt 3: Scharfschalten

```javascript
var DRY_RUN = false;
```

Skript neu starten. Ab jetzt wird das Register beschrieben.

### Schritt 4: Feintuning

Nach einigen Tagen die Schwellwerte anhand der Grafana-Daten anpassen:
- `PV_PROGNOSE_HOCH` – abhängig von tatsächlich guten Tagen
- `LEISTUNG_SANFT` – je nach gewünschter Batterischonung
- `RUECKSTAND_KRITISCH` – je nach Toleranz für Abweichungen

---

## Logging

Alle Ausgaben haben das Präfix `[Ladesteuerung]` und erscheinen im ioBroker Protokoll.

| Präfix | Bedeutung |
|--------|-----------|
| `[Ladesteuerung]` | Info – normaler Betrieb |
| `[Ladesteuerung] ⚠️` | Warnung – Eingriff nötig |
| `[Ladesteuerung] [DRY RUN]` | Testmodus – würde schreiben |

**Beispiel-Log eines normalen Stundendurchlaufs:**
```
[Ladesteuerung] === Stündliche Prüfung | 11:00:00 ===
[Ladesteuerung] SOC: 42% | PV heute: 3.2 kWh | PV Prognose noch: 28.4 kWh | Reststunden bis 15 Uhr: 4.0h | Basisleistung: 1392W
[Ladesteuerung] PV-Verhältnis: 88% (real 3.2 kWh / erwartet 3.6 kWh)
[Ladesteuerung] SOC-Anstieg: erwartet 16% / tatsächlich 14% | Rückstand diese Stunde: 2% | Kumulierter Rückstand: 2.0%
[Ladesteuerung] PV moderat unter Prognose (88%) → Basisleistung 1392W
[Ladesteuerung] Geschrieben: 1400W (vorher: 1500W) | PV moderat unter Prognose...
```

---

## Bekannte Einschränkungen

- Der **kumulierte Rückstand** wird bei Skript-Neustart zurückgesetzt
- Der **Tagesprognose-Gesamtwert** wird nur einmal um 09:00 Uhr gesetzt – ein Neustart danach setzt `tagesPrognose = null` bis zum nächsten Tag
- Das Skript reagiert nur **stündlich** – schnelle Wetteränderungen werden erst zur nächsten vollen Stunde berücksichtigt

---

## Abhängigkeiten

- ioBroker **JavaScript Adapter** ≥ 6.x
- ioBroker **Modbus Adapter** – Sungrow SH10RT eingebunden
- ioBroker **pvforecast Adapter** – mit Solcast oder forecast.solar konfiguriert
- Sungrow SH10RT Firmware mit Modbus TCP Zugriff (LAN-Anschluss)

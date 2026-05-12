# Sungrow SH10RT – Adaptive Ladesteuerung

**Version:** 1.0.6  
**Plattform:** ioBroker JavaScript Adapter  
**Wechselrichter:** Sungrow SH10RT-20  
**Batterie:** Sungrow SBR096 (9,6 kWh)

---

## Ziel

Die Batterie soll an sonnigen Tagen möglichst schonend und gleichmäßig über den Tag verteilt geladen werden – mit dem obersten Ziel, bis **16:00 Uhr auf 100% SOC** zu kommen. Bei schlechter PV-Ausbeute oder Rückstand wird die Ladeleistung automatisch erhöht.

---

## Funktionsweise

Das Skript läuft **einmal pro Stunde um :02** (pvforecast-Adapter aktualisiert bei :00:30, Lesen bei :02 stellt frische Daten sicher) und entscheidet anhand von drei Steuerungsgrößen, welche maximale Ladeleistung ins Modbus Holding Register geschrieben wird.

### Zeitfenster

| Zeitraum | Verhalten |
|----------|-----------|
| Vor 08:00 Uhr | MAX_LEISTUNG freigegeben (WR und Batterie regeln selbst) |
| 08:00–17:00 Uhr | Adaptive Steuerung aktiv |
| Nach 17:00 Uhr | MAX_LEISTUNG freigegeben |

### Steuerungsgrößen

#### 1. Basisleistung

Die Mindestleistung die rechnerisch nötig ist, um das Ziel pünktlich zu erreichen:

```
Basisleistung = (fehlende kWh bis 100%) / (Stunden bis 16:00) × 1000
```

**Beispiele:**

| Uhrzeit | SOC | Fehlende kWh | Reststunden | Basisleistung |
|---------|-----|-------------|-------------|---------------|
| 08:00 | 5% | 9,12 kWh | 8,0 h | 1140 W |
| 10:00 | 25% | 7,20 kWh | 6,0 h | 1200 W |
| 12:00 | 50% | 4,80 kWh | 4,0 h | 1200 W |
| 14:00 | 60% | 3,84 kWh | 2,0 h | 1920 W |
| 15:00 | 30% | 6,72 kWh | 1,0 h | 6570 W (MAX) |

#### 2. PV-Verhältnis

Stündlicher Vergleich: tatsächliche Erzeugung vs. was laut Prognose bis jetzt hätte erzeugt werden sollen.

```
PV-Verhältnis = pv_energy_today (Wh) / pvforecast.energy.now (Wh)
```

Der Vergleich ist erst ab 500 Wh Prognosewert sinnvoll (früh morgens zu wenig Datenbasis). Darunter wird das Verhältnis als unbekannt geloggt.

| Verhältnis | Bedeutung | Reaktion |
|------------|-----------|----------|
| > 90% | Prognose stimmt | Plan beibehalten |
| 70–90% | Etwas schwächer | Basisleistung verwenden |
| < 70% | Deutlich schlechter | Sofort MAX_LEISTUNG |

#### 3. SOC-Rückstand (kumuliert)

Jede Stunde wird verglichen wie viel der SOC gestiegen ist vs. was bei der **Basisleistung der Vorperiode** zu erwarten gewesen wäre. Die Abweichungen werden über den Tag aufsummiert.

```
Erwarteter SOC-Anstieg = basisLeistungVorigeStunde (kW) / 9,6 kWh × 100
Rückstand = max(0, erwartet - tatsächlich)
Kumulierter Rückstand += Rückstand dieser Stunde
```

Wichtig: Als Referenz dient die **Basisleistung** (Mindestleistung zum Erreichen des Ziels), nicht die tatsächlich ins Register geschriebene Leistung. Das Register ist ein Ceiling – wieviel wirklich fließt hängt vom PV-Überschuss ab.

**Beispiel:**

| Stunde | Basisl. Vorh. | Erw. SOC+ | Ist SOC+ | Rückstand | Kumuliert |
|--------|---------------|-----------|----------|-----------|-----------|
| 09:00 | 1140 W | 11,9% | 10,0% | 1,9% | 1,9% |
| 10:00 | 1200 W | 12,5% | 5,0% | 7,5% | 9,4% |
| 11:00 | – | – | – | – | → **KRITISCH** |

| Kumulierter Rückstand | Reaktion |
|----------------------|----------|
| < 5% | Nichts tun |
| 5–10% | Basisleistung × 1,5 |
| > 10% | Sofort MAX_LEISTUNG |

### Entscheidungsreihenfolge

Die Priorität ist von oben nach unten:

1. **SOC bereits 100%** → MAX freigeben, WR regelt selbst
2. **Zeit überschritten (nach 16:00)** → MAX freigeben
3. **Kumulierter Rückstand > 10%** → sofort MAX_LEISTUNG
4. **PV-Verhältnis < 70%** → sofort MAX_LEISTUNG
5. **Kumulierter Rückstand 5–10%** → Basisleistung × 1,5
6. **PV-Verhältnis 70–90%** → Basisleistung
7. **Niedrige Tagesprognose (< 35 kWh)** → sofort MAX_LEISTUNG (schlechter Tag)
8. **Viel PV (Tagesprognose > 40 kWh) + alles im Plan** → max(Basisleistung, 1500W)
9. **Normalbetrieb (35–40 kWh)** → Basisleistung

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

| Parameter | Aktuell | Beschreibung |
|-----------|---------|--------------|
| `DRY_RUN` | `true` | Testmodus – kein Schreiben ins Register |
| `ZIEL_UHRZEIT` | `16` | Zielzeit für vollen Akku |
| `ZIEL_SOC` | `100` | Ziel-Ladestand in % |
| `BATTERIE_KWH` | `9.6` | Nutzbare Kapazität in kWh |
| `MAX_LEISTUNG` | `6570` | Maximale Ladeleistung in W |
| `MIN_LEISTUNG` | `500` | Minimale Ladeleistung in W |
| `START_STUNDE` | `8` | Steuerung aktiv ab (Uhr) |
| `END_STUNDE` | `17` | Steuerung aktiv bis (Uhr) |
| `PV_PROGNOSE_NIEDRIG` | `35000` | Schwellwert "schlechter Tag" in Wh → sofort MAX_LEISTUNG. Empirisch (10.05.2026): bei 28 kWh Prognose war Batterie abends nur 10% – zu konservativ geladen |
| `PV_PROGNOSE_HOCH` | `40000` | Schwellwert "guter Tag" in Wh → sanft laden. Empirisch (09.05.2026): 30 kWh Produktion reichte für volle Batterie + Einspeisung |
| `LEISTUNG_SANFT` | `1500` | Leistung bei viel Sonne und Plan OK |
| `RUECKSTAND_MODERAT` | `5` | SOC-Rückstand % → Leistung × 1,5 |
| `RUECKSTAND_KRITISCH` | `10` | SOC-Rückstand % → sofort MAX_LEISTUNG |
| `PV_VERH_GUT` | `0.9` | PV-Verhältnis ab dem Plan als "gut" gilt |
| `PV_VERH_MODERAT` | `0.7` | PV-Verhältnis ab dem sofort MAX_LEISTUNG |

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

Nach einigen Wochen die Schwellwerte anhand der InfluxDB-Daten anpassen:
- `PV_PROGNOSE_HOCH` – anhand realer Produktionsdaten kalibrieren (Forecast vs. Ist)
- `LEISTUNG_SANFT` – je nach gewünschter Batterieschonung
- `RUECKSTAND_KRITISCH` – je nach Toleranz für Abweichungen
- `PV_VERH_MODERAT` – falls Forecast systematisch zu optimistisch ist, erhöhen

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
[Ladesteuerung] === Stündliche Prüfung | 11:02:00 ===
[Ladesteuerung] SOC: 42% | PV heute: 3.2 kWh | PV Prognose noch: 28.4 kWh | Reststunden bis 16 Uhr: 5.0h | Basisleistung: 1044W
[Ladesteuerung] PV-Verhältnis: 88% (real 3.2 kWh / erwartet 3.6 kWh)
[Ladesteuerung] SOC-Anstieg: erwartet 11% / tatsächlich 9.5% | Rückstand diese Stunde: 1.5% | Kumulierter Rückstand: 1.5%
[Ladesteuerung] PV moderat unter Prognose (88%) → Basisleistung 1044W
[Ladesteuerung] Geschrieben: 1000W (vorher: 1100W) | PV moderat unter Prognose...
```

---

## Bekannte Einschränkungen

- Der **kumulierte Rückstand** und `basisLeistungVorigeStunde` werden bei Skript-Neustart zurückgesetzt
- Der **Tagesprognose-Gesamtwert** wird nur einmal um START_STUNDE gesetzt – ein Neustart danach setzt `tagesPrognose = null` bis zum nächsten Tag
- Das Skript reagiert nur **stündlich** – schnelle Wetteränderungen werden erst zur nächsten Stunde berücksichtigt
- Das PV-Verhältnis ist erst ab 500 Wh pvNow aussagekräftig (in den ersten Morgenstunden unbekannt)

---

## Abhängigkeiten

- ioBroker **JavaScript Adapter** ≥ 6.x
- ioBroker **Modbus Adapter** – Sungrow SH10RT eingebunden
- ioBroker **pvforecast Adapter** – mit Solcast oder forecast.solar konfiguriert
- Sungrow SH10RT Firmware mit Modbus TCP Zugriff (LAN-Anschluss)

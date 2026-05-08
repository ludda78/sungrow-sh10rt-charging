# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Sungrow SH10RT Adaptive Charging Controller** is a battery charging automation system that dynamically controls the maximum charging power of a Sungrow hybrid inverter to charge the battery smoothly throughout the day while meeting a target charge level by a specified deadline (default 3:00 PM).

The system runs as a scheduled JavaScript script in ioBroker, evaluating solar generation forecasts, battery state-of-charge trends, and time-to-target to optimize charging behavior under varying weather and grid conditions.

## Architecture

### Execution Model
- **Trigger**: Hourly cron schedule (`0 * * * *`) – runs at the top of each hour
- **Runtime**: ~50-100ms per execution (reads inputs, calculates, writes output if changed)
- **State**: Maintains in-memory state across hourly cycles (SOC drift tracking, daily forecast)
- **Output**: Single Modbus Holding Register write (only if power changes by >100W)

### Core Control Logic (Priority Order)

The script applies a cascading decision tree to determine charging power:

1. **Terminal Conditions** (highest priority)
   - SOC already at 100% → Release max power (inverter self-regulates)
   - Time deadline exceeded (after target hour) → Force max power
   - Active time window (9–17) not reached → Release max power outside window

2. **Error/Alert Conditions**
   - Cumulative SOC lag ≥ 10% → Immediately 6000W (critical recovery)
   - PV ratio < 70% (real vs. forecast) → Immediately 6000W (bad weather detected)

3. **Moderate Warning**
   - Cumulative SOC lag 5–10% → Base power × 1.5 (speed up charging)

4. **Nominal Conditions** (default path)
   - PV ratio 70–90% → Use base power (slightly underperforming)
   - High forecast (>50 kWh daily) + on-schedule → Gentle power (protect battery)
   - Normal operation → Base power (calculated to hit target on time)

### Three Control Signals

**1. Base Power** (time-based calculation)
```
Base Power = (missing kWh to 100%) / (hours until target time) × 1000
```
Ensures linear charging trajectory to hit the deadline. Updated hourly as SOC changes.

**2. PV Ratio** (weather monitoring)
```
PV Ratio = actual generated today (Wh) / forecasted by this time (Wh)
```
Detects if current weather is better or worse than forecast. Thresholds:
- > 90%: Forecast on track
- 70–90%: Slightly underperforming
- < 70%: Significantly worse than expected (increases power immediately)

**3. Cumulative SOC Lag** (drift correction)
```
Lag this hour = max(0, expected_rise - actual_rise)
Cumulative Lag += lag this hour
```
If battery isn't rising as fast as charging power suggests, cumulative error triggers proportional power increase. Resets daily at 9 AM.

### State Variables

| Variable | Purpose | Lifecycle |
|----------|---------|-----------|
| `letzterWert` | Last written power to register | Updated each write (prevents state drift) |
| `socVorEinerStunde` | SOC reading from previous hour | Updated each cycle; reset outside active window |
| `kumulierterRueckstand` | Summed SOC lag over the day | Reset at 9 AM; accumulates through day |
| `tagesPrognose` | Total daily PV forecast | Set once at 9 AM; resets next day |

## Configuration

All parameters are defined in the `KONFIGURATION` section at the top of `ladesteuerung.js`. Key tuning variables:

| Parameter | Default | Tuning Notes |
|-----------|---------|--------------|
| `DRY_RUN` | `true` | **Start with `true`** for 1–2 days before enabling writes |
| `ZIEL_UHRZEIT` | `15` | Target hour (24-hour format) |
| `ZIEL_SOC` | `100` | Target state of charge (%) |
| `START_STUNDE` / `END_STUNDE` | `9` / `17` | Active control window; outside → max power |
| `PV_PROGNOSE_HOCH` | `50000` Wh | Threshold for "sunny day" (gentle loading mode) |
| `LEISTUNG_SANFT` | `1500` W | Gentle charging power on sunny days (battery protection) |
| `RUECKSTAND_MODERAT` | `5%` | SOC lag threshold to trigger 1.5× power multiplier |
| `RUECKSTAND_KRITISCH` | `10%` | SOC lag threshold to trigger immediate max power |
| `PV_VERH_GUT` | `0.9` | PV ratio above which forecast is considered accurate |
| `PV_VERH_MODERAT` | `0.7` | PV ratio below which to force max power |

### Tuning Workflow

1. **Initial deployment**: Leave `DRY_RUN = true` for 1–2 sunny days
2. **Monitor logs**: Check ioBroker Protokoll for `[Ladesteuerung]` entries
3. **Adjust thresholds**: Based on real performance (Grafana or InfluxDB graphs):
   - If battery regularly overshoots: lower `PV_PROGNOSE_HOCH` or `LEISTUNG_SANFT`
   - If battery undershoots: lower `RUECKSTAND_KRITISCH` or `RUECKSTAND_MODERAT`
   - If forecast data is unreliable: increase `PV_VERH_MODERAT` (more conservative)
4. **Enable production**: Set `DRY_RUN = false` and restart script

## ioBroker Integration Points

The script reads/writes via Modbus adapter. Data points are defined at the top of `ladesteuerung.js`:

### Inputs (Read)
- `modbus.0.inputRegisters.13022_Battery_level_` – SOC (%)
- `modbus.0.inputRegisters.13001_Daily_PV_Generation` – PV generated today (kWh)
- `pvforecast.0.summary.energy.now` – Forecast for already-passed hours (Wh)
- `pvforecast.0.summary.energy.nowUntilEndOfDay` – Forecast for remaining hours (Wh)

### Outputs (Write)
- `modbus.0.holdingRegisters.33046_Max_Charging_Power` – Max charge rate (W)

**Write Optimization**: Register only updated if new power differs by > 100W; values rounded to nearest 100W. Typical: 5–15 writes/day.

## Logging & Debugging

All output prefixed with `[Ladesteuerung]`. Log levels:

- `[Ladesteuerung]` – Info (normal operation)
- `[Ladesteuerung] ⚠️` – Warning (thresholds exceeded, corrective action taken)
- `[Ladesteuerung] [DRY RUN]` – Test mode output (what would be written)

**Check logs in ioBroker**:
```
Admin > Protokoll (Protocol) → Filter "Ladesteuerung"
```

**Expected hourly output** (during 9–17 window):
```
[Ladesteuerung] === Stündliche Prüfung | 11:00:00 ===
[Ladesteuerung] SOC: 45% | PV heute: 3.2 kWh | PV Prognose noch: 28.4 kWh | Reststunden bis 15 Uhr: 4.0h | Basisleistung: 1350W
[Ladesteuerung] PV-Verhältnis: 88% (real 3.2 kWh / erwartet 3.6 kWh)
[Ladesteuerung] SOC-Anstieg: erwartet 16% / tatsächlich 14% | Rückstand diese Stunde: 2% | Kumulierter Rückstand: 3.5%
[Ladesteuerung] PV moderat unter Prognose (88%) → Basisleistung 1350W
[Ladesteuerung] Geschrieben: 1400W (vorher: 1500W) | PV moderat unter Prognose...
```

## Development Workflow

### Testing in DRY_RUN Mode

1. **Deploy script**: Copy `ladesteuerung.js` to ioBroker JavaScript Adapter
2. **Verify data points**: Check that all `DP_*` variables resolve (no missing Modbus registers)
3. **Monitor overnight**: Leave `DRY_RUN = true` for a full sunny day
4. **Review logs**: Look for:
   - Are reads (SOC, PV values) plausible?
   - Are calculated powers reasonable?
   - Are warnings (`⚠️`) logical?

### Enabling Production

```javascript
var DRY_RUN = false;  // Enable actual register writes
```

Restart the script. Verify that actual power adjustments occur and align with log recommendations.

### Diagnosing Issues

**Issue: SOC not rising as expected**
- Check if `DP_HR_LADEN` register is actually changing in Modbus
- Verify inverter isn't throttling (cloud shadows, thermal limits)
- Check if `letzterWert` is being persisted across script restarts

**Issue: Lag accumulates rapidly (stays > 5%)**
- PV forecast may be overly optimistic; decrease `PV_PROGNOSE_HOCH` threshold
- Battery SOC rise may be slower than physics suggests; reduce `LEISTUNG_SANFT`
- Script restarts reset cumulative lag (expected behavior)

**Issue: Log values look wrong**
- Verify `DP_*` paths match your ioBroker objects (Modbus instance, register numbers)
- Check pvforecast adapter is running and data is fresh

## Known Limitations

1. **State reset on script restart**: Cumulative SOC lag (`kumulierterRueckstand`) resets to 0. Daily forecast (`tagesPrognose`) resets to null until next 9 AM.
2. **Hourly resolution**: Rapid weather changes (clouds, microbursts) only detected at the next hour boundary.
3. **Forecast dependency**: If PV forecast adapter is offline or stale, script falls back to base power (safe but not optimal).
4. **No persistence layer**: State is in-memory only; ioBroker persistence plugins could improve across-restart continuity.

## Code Structure

### Main Sections

1. **Configuration** (lines 10–34): User-tunable parameters
2. **Data Points** (lines 40–44): ioBroker object paths
3. **State Variables** (lines 50–53): Persistent in-memory state
4. **Helper Functions** (lines 59–94):
   - `log_info()` / `log_warn()`: Logging with prefix
   - `schreibeLeistung()`: Register write with deduplication + DRY_RUN check
   - `berechneBasisleistung()`: Time-based power calculation
5. **Main Scheduler** (lines 100–233): Hourly execution logic
   - Tagesstart handling (9 AM reset)
   - Boundary checks (outside active window, SOC/time deadlines)
   - Read inputs → calculate signals → apply decision tree → write output
6. **Startup Log** (line 235): Confirmation message

### Key Functions

**`berechneBasisleistung(soc, restStunden)`**
- Input: current SOC (%), hours remaining to target time
- Output: minimum watts to reach 100% by deadline
- Formula: missing_kWh / rest_hours × 1000

**`schreibeLeistung(leistung, grund)`**
- Clamps power to [MIN_LEISTUNG, MAX_LEISTUNG]
- Rounds to 100W (reduces register churn)
- Only writes if change > 100W (write deduplication)
- Logs actual write or DRY_RUN simulation
- Updates `letzterWert` to reflect register state

### Schedule Trigger

```javascript
schedule('0 * * * *', function() { ... })
```

ioBroker JavaScript Adapter native scheduling. Fires at `:00` of each hour in the local timezone.

## Language & Dependencies

- **Language**: JavaScript (ES5-compatible subset for ioBroker)
- **Runtime**: ioBroker JavaScript Adapter (≥ 6.x)
- **External Adapters Required**:
  - Modbus Adapter (for Sungrow inverter communication)
  - pvforecast Adapter (for solar irradiance forecasting, e.g., Solcast or forecast.solar)
- **Device**: Sungrow SH10RT hybrid inverter (20 kW) + SBR096 battery (9.6 kWh)

## Modification Guidelines

### Safe Changes

- Adjust `CONFIGURATION` section thresholds (parameters are isolated, do not require logic refactoring)
- Modify `DP_*` paths if your Modbus instance or registers change
- Add additional logging (expand `log_info()` calls)
- Extend decision logic (add new conditions in the priority-ordered cascade)

### Risky Changes

- Altering the decision tree structure without testing in DRY_RUN (can cause erratic charging)
- Removing or renaming state variables without careful lifecycle management
- Changing the schedule pattern or active time window without manual testing
- Modifying the base power formula without domain knowledge of battery chemistry

### Common Extensions

**Add weather override**:
```javascript
if (temperature > 45) {
    leistung = Math.min(leistung, 3000);  // Thermal throttling
}
```

**Add grid frequency coupling**:
```javascript
var gridFreq = getState('...');
if (gridFreq > 50.1) {
    leistung = Math.max(leistung, MAX_LEISTUNG);  // Support grid
}
```

**Add load prediction**:
```javascript
var expectedLoad = getState('...');
var availablePV = pvNochWh - expectedLoad;
if (availablePV < 0) leistung = MIN_LEISTUNG;  // Can't charge, grid will be needed
```

## Documentation Reference

- **Detailed Algorithm**: See `doku_sungrow_charge_automation.md` for full control logic, examples, and mathematical formulas
- **Sungrow SH10RT Manual**: Modbus register reference (Holding Register 33046 is Max_Charging_Power)
- **pvforecast Adapter Docs**: Solcast / forecast.solar API integration

# Metrics and interpretation

## Scope and identity

These are **interval grid energy readings**, normally half-hourly, not live power
or cumulative meter-register readings. Import is energy drawn from the grid;
export is energy sent to the grid. Neither is total household consumption or
total solar generation. Battery activity and self-consumed solar cannot be
inferred reliably without additional generation/storage meters.

Every point has the `app=octopus-energy-consumption-metrics` tag and the Octopus
**interval-end** timestamp, represented as nanoseconds in line protocol. Rates are
matched using interval start **and full interval coverage**, with exclusive ends
for adjacent tariff/rate periods (a reading ending at a boundary belongs to the
earlier interval). Prices and energy are never shifted to the collection time.
`interval_seconds` records actual elapsed duration; do not assume every interval
is exactly 30 minutes.

There are no meter identity tags: this collector currently supports one import
and one export stream per destination. Use separate buckets for multiple
properties/collectors; otherwise equal measurement/tag/timestamps can collide.

## Electricity import: `electricity_import`

| Field | Type | Unit / interpretation |
| --- | --- | --- |
| `energy_kwh` | float | Imported kWh in the interval |
| `interval_seconds` | float | Interval duration in seconds |
| `unit_rate_gbp_per_kwh` | float | Applicable import rate, pounds/kWh, including VAT |
| `usage_cost_gbp` | float | `energy_kwh * unit_rate_gbp_per_kwh` |
| `daily_standing_charge_gbp` | float | Applicable daily standing charge, pounds/day, including VAT |
| `standing_charge_gbp` | float | `daily_standing_charge_gbp * interval_seconds / 86400` |
| `total_cost_gbp` | float | `usage_cost_gbp + standing_charge_gbp`; only emitted when both are available |
| `unit_rate_available` | boolean | Whether API unit pricing was resolved on this poll |
| `standing_charge_available` | boolean | Whether API standing-charge pricing was resolved on this poll |
| `tariff_code` | string | Agreement covering the entire interval; absent if missing/ambiguous |
| `pricing_source` | string | `octopus` for collector points |

Tariff codes are **fields**, not tags, to keep point identity stable if historical
agreements are corrected.

## Electricity export: `electricity_export`

| Field | Type | Unit / interpretation |
| --- | --- | --- |
| `energy_kwh` | float | Exported kWh in the interval |
| `interval_seconds` | float | Interval duration in seconds |
| `unit_rate_gbp_per_kwh` | float | Applicable export payment rate, pounds/kWh, excluding VAT |
| `revenue_gbp` | float | `energy_kwh * unit_rate_gbp_per_kwh` |
| `unit_rate_available` | boolean | Whether API export pricing was resolved on this poll |
| `tariff_code` | string | Export agreement covering the interval, when unambiguous |
| `pricing_source` | string | `octopus` for collector points |

For example, 1.25 kWh at 15p/kWh produces `unit_rate_gbp_per_kwh=0.15` and
`revenue_gbp=0.1875`.

No standing charge is charged again on export. Import prices are never used for
exports. Zero energy and zero/negative rates are valid and retained; negative
export rates produce negative revenue, not a positive payment.

This is **estimated accrued revenue**, not a paid/billed amount. For domestic,
non-VAT-registered export the collector uses the API's `value_exc_vat` without
adding VAT; fixed Outgoing examples expose the same inclusive/exclusive value.
Business/VAT-registered self-billing, tax, credits, and payment reconciliation
need separate accounting. Import uses `value_inc_vat`, never a hard-coded uplift.

## How API pricing is resolved

1. Refresh the account's meter points and agreement history every poll.
2. Select import/export MPAN and serial independently. Optional environment
   filters disambiguate discovery; an account number is required for pricing.
3. For every agreement overlapping the reading window, derive its product from
   its `E-1R-{product}-{region}` tariff code.
4. Request standard unit rates (plus import standing charges), restricted to the
   agreement/reading date intersection. Follow **all rate pages**.
5. Match each reading against a unique agreement and rate covering the **whole**
   interval. Match by validity instants, not the tariff's current display price.
6. Convert API pence to pounds once, then calculate interval amounts.

Import prefers `DIRECT_DEBIT` rates, falling back to `payment_method: null`.
Export prefers null, falling back to direct debit. Other payment methods,
conflicting rates, missing agreements and gaps are unpriced rather than guessed.
This is intended for domestic direct-debit import and standard export accounts.
Multi-register `E-2R`, Economy 7 day/night, demand charges and bespoke tariffs
are not priced by pretending their rates are standard single-register rates.
They still produce energy and explicit missing-pricing warnings.

If a reading spans a tariff/rate change and no single rate covers the interval,
its energy is kept but it is unpriced. We do not allocate interval energy across
unknown sub-interval consumption. Timestamps are parsed with their API timezone
offsets; matching is by absolute instant, including around DST.

### Missing prices are not zero

Rate HTTP/network/timeouts produce warnings and retain energy. Missing unit rates
omit the unit rate and usage cost/revenue. Missing standing charges omit daily and
interval standing charges; total cost requires **both** flags true. Invalid
reading values, malformed response structures, account discovery failures and
ambiguous meter identities fail the poll.

**InfluxDB merges fields on repeated point writes.** A formerly priced point can
retain an older monetary field after a later poll cannot price it. Always pivot
and test availability flags on the same point before calculating finances. Do not
just sum raw stored monetary fields or fill missing prices with zero. A later
successful poll can restore availability and correct the amounts.

The flags represent price availability, **not completeness of the energy series**.
Report missing intervals and pricing coverage alongside daily/monthly totals;
partial sums are not complete bills.

### Estimates versus bills

- Calculations use unrounded API kWh and floating-point arithmetic, not an exact
  reproduction of supplier billing rounding. Final billed totals can differ.
- Standing charges are allocated by elapsed seconds / 86400. This is a monitoring
  convention, not a billing calendar. A 23/25-hour UK day allocates 23/24 or 25/24
  of one charge if all intervals are present.
- A day with missing meter readings cannot have its full daily standing charge
  reconstructed by summing available intervals alone.
- Tariff/payment changes, adjustments and eventual smart-meter corrections can
  alter estimates. Only the newest `PAGE_SIZE` readings are revisited each poll.
- Overlapping polls update identical points; they must not be treated as new
  independent revenue events.

### Historical backfill

`npm run backfill` explicitly requests all available history for the configured
meters, follows reading pagination, and prices/writes each page separately.
The date lower bound is 1970-01-01; returned coverage depends on Octopus's records
and your selected MPAN/serial, not on this requested date. Normal polling still
revisits only its newest `PAGE_SIZE` readings.

Check bucket retention before backfilling: old points can be rejected rather
than extending retention automatically. Downstream copy windows must include
older backfilled points; write them to your intended long-retention bucket or
explicitly copy the historical range separately. Keep the `app` tag
convention consistent when combining direct writes and archived copies.

## Dashboard calculations

Energy fields and interval money fields are additive over **non-overlapping**
intervals. Unit rates and daily standing-charge rates are not: never sum those.

| Statistic | Calculation |
| --- | --- |
| Imported/exported energy | Sum each direction's `energy_kwh` |
| Export revenue | Sum `revenue_gbp` where `unit_rate_available` is true |
| Import cost | Sum `total_cost_gbp` where both pricing flags are true |
| Net grid energy | Imported kWh minus exported kWh over aligned coverage |
| Net grid cost | Import cost minus export revenue over aligned, fully priced coverage |
| Effective export rate | Priced revenue / exported kWh **from those same priced intervals** |
| Average interval grid power | `energy_kwh * 3600 / interval_seconds` (kW, not instantaneous power) |

Use Europe/London for UK billing-day boundaries if desired. Because timestamps
are interval ends, a reading ending at midnight belongs to the preceding day.
Shift timestamps back **1 nanosecond in the aggregation query**, not in stored
raw data, before daily `aggregateWindow`.

Example: safely select priced export intervals in Flux:

```flux
from(bucket: "YOUR_BUCKET")
    |> range(start: -7d)
    |> filter(fn: (r) => r._measurement == "electricity_export")
    |> filter(fn: (r) => contains(value: r._field,
        set: ["energy_kwh", "revenue_gbp", "unit_rate_available"]))
    |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
    |> filter(fn: (r) => exists r.unit_rate_available and r.unit_rate_available)
```

For daily revenue, follow with:

```flux
    |> timeShift(duration: -1ns)
    |> aggregateWindow(every: 1d, column: "revenue_gbp", fn: sum, createEmpty: false,
        location: {zone: "Europe/London", offset: 0h})
```

Compute coverage separately before treating that sum as complete. For net cost,
join import and export by interval-end timestamp (and matching duration) before
subtracting, so a missing reading does not become a fictitious zero.

## Gas: unchanged legacy schema

Gas support is best-effort and is not live-tested by the current maintainer.
Mocked tests cover existing configuration, conversion, output and backfill
behavior, not the correctness of a real meter's units or financial estimates.

| Measurement | Field | Interpretation |
| --- | --- | --- |
| `gas` | `consumption` | Raw Octopus consumption value in the meter's reported units |
| `gaskwh` | `consumption_kwh` | Raw value * `VOLUME_CORRECTION` * `CALORIFIC_VALUE` / `JOULES_CONVERSION` |
| `gas_cost` | `price` | Converted kWh * manually configured `OCTO_GAS_COST` / 100, pounds |

Octopus may return kWh for SMETS1 gas and cubic metres for SMETS2. The existing
conversion assumes a volume input and has no automatic unit discovery. Do not
enable it without checking your meter: already-converted kWh would be converted
again. Gas costs still use manual configuration; this change removes manual
**electricity** pricing only.

## Schema changes and downstream storage

Compatibility is not guaranteed. The following table describes the field changes
for downstream consumers; it is not an automatic migration:

| Legacy measurement.field | New measurement.field |
| --- | --- |
| `electricity.consumption` | `electricity_import.energy_kwh` |
| `electricity.unitprice` | `electricity_import.unit_rate_gbp_per_kwh` |
| `electricity.usageprice` | `electricity_import.usage_cost_gbp` |
| `electricity.daily_standing_charge` | `electricity_import.daily_standing_charge_gbp` |
| `electricity.standing_change` | `electricity_import.standing_charge_gbp` |
| `electricity.totalprice` | `electricity_import.total_cost_gbp` |
| `electricity_export.consumption` | `electricity_export.energy_kwh` |

Legacy imports used manual fallbacks and interval-end rate matching. Renaming
those fields does not certify their prices. Do not invent historical tariff
codes, durations, rates, revenue, or true availability flags without evidence.
Keep unverified history distinguishable from API-priced data.

Archiving, migration scripts, bucket names and retention policies are
deployment-specific and are not shipped or applied by this collector. Back up and
validate transformations separately before updating downstream dashboards/tasks.
Preserve field types, timestamps and availability flags; never combine old and
new schema over identical intervals and sum both. Keep tag conventions consistent:
dropping a tag changes series identity and can produce double counting alongside
direct writes.

An archive's correction window is effective only if the collector re-fetches
that period. Normal polling revisits its newest `PAGE_SIZE` readings; backfill
explicitly retrieves historical pages. A short rolling archive window does not
automatically copy older backfilled data.

## Sources

- [Octopus REST endpoint guide](https://docs.octopus.energy/rest/guides/endpoints/):
  accounts, agreements, consumption, rate validity, pagination and billing rounding.
- [Fixed Outgoing example rate feed](https://api.octopus.energy/v1/products/OUTGOING-FIX-12M-19-05-13/electricity-tariffs/E-1R-OUTGOING-FIX-12M-19-05-13-A/standard-unit-rates/):
  export rates with null payment method and matching VAT-inclusive/exclusive values.

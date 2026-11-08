import {Point} from '@influxdata/influxdb-client'
import type {GasConfig} from './config.js'
import type {AgreementPrices, Reading} from './types.js'
import {intervalPrices} from './pricing.js'

function point(measurement: string): Point {
    return new Point(measurement).tag('app', 'octopus-energy-consumption-metrics')
}

function date(value: unknown, name: string): Date {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        throw new Error(`Invalid ${name}: expected an ISO timestamp`)
    }
    return new Date(value)
}

function consumption(reading: Reading, fuel: string): number {
    if ((typeof reading.consumption !== 'number' && typeof reading.consumption !== 'string') ||
        (typeof reading.consumption === 'string' && !reading.consumption.trim()) ||
        !Number.isFinite(Number(reading.consumption))) {
        throw new Error(`Invalid ${fuel} reading: expected numeric consumption`)
    }
    return Number(reading.consumption)
}

export function electricityPoints(readings: Reading[], prices: AgreementPrices[], isExport = false): Point[] {
    return readings.map(reading => {
        const start = date(reading.interval_start, 'electricity interval_start')
        const end = date(reading.interval_end, 'electricity interval_end')
        const seconds = (end.valueOf() - start.valueOf()) / 1000
        if (seconds <= 0) throw new Error('Invalid electricity reading: interval_end must follow interval_start')
        const direction = isExport ? 'export' : 'import'
        const {unitRate, dailyStandingCharge, tariffCode} = intervalPrices(prices, start, end, isExport)
        const usage = consumption(reading, 'electricity')
        const result = point(`electricity_${direction}`)
            .floatField('energy_kwh', usage)
            .floatField('interval_seconds', seconds)
            .stringField('pricing_source', 'octopus')
            .booleanField('unit_rate_available', unitRate !== undefined)
            .timestamp(end)
        if (tariffCode) result.stringField('tariff_code', tariffCode)
        if (unitRate !== undefined) {
            result.floatField('unit_rate_gbp_per_kwh', unitRate)
                .floatField(isExport ? 'revenue_gbp' : 'usage_cost_gbp', usage * unitRate)
        } else {
            console.warn(`Missing ${direction} unit rate for interval starting ${start.toISOString()}; energy retained without priced usage`)
        }
        if (!isExport) {
            result.booleanField('standing_charge_available', dailyStandingCharge !== undefined)
            if (dailyStandingCharge !== undefined) {
                const charge = dailyStandingCharge * seconds / 86400
                result.floatField('daily_standing_charge_gbp', dailyStandingCharge)
                    .floatField('standing_charge_gbp', charge)
                if (unitRate !== undefined) result.floatField('total_cost_gbp', usage * unitRate + charge)
            } else {
                console.warn(`Missing import standing charge for interval starting ${start.toISOString()}; energy retained without total cost`)
            }
        }
        return result
    })
}

export function gasPoints(readings: Reading[], config: GasConfig): Point[] {
    return readings.flatMap(reading => {
        const end = date(reading.interval_end, 'gas interval_end')
        const usage = consumption(reading, 'gas')
        const kwh = usage * config.volumeCorrection * config.calorificValue / config.joulesConversion
        return [
            point('gas').floatField('consumption', usage).timestamp(end),
            point('gaskwh').floatField('consumption_kwh', kwh).timestamp(end),
            point('gas_cost').floatField('price', kwh * config.unitCostPence / 100).timestamp(end)
        ]
    })
}

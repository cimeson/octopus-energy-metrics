import {setTimeout as sleep} from 'node:timers/promises'
import type {Point} from '@influxdata/influxdb-client'
import {readConfig, type Environment} from './config.js'
import {OctopusClient} from './octopus.js'
import {selectElectricityMeter} from './discovery.js'
import {electricityPoints, gasPoints} from './points.js'
import {outputPoints} from './output.js'
import {intervalPrices} from './pricing.js'
import type {Account, AgreementPrices, ElectricityMeterPoint, Reading} from './types.js'

interface HistorySummary {
    readings: number
    priced: number | null
    batches: number
    earliest: string | null
    latest: string | null
}

export async function boot(environment: Environment = process.env, backfill = false): Promise<void> {
    const config = readConfig(environment)
    const client = new OctopusClient(config.apiKey, config.timeoutSeconds)
    console.log('Starting Octopus Energy Metrics')
    console.log(`PAGE_SIZE=${config.pageSize}, LOOP_TIME=${config.loopTime}, DRY_RUN=${config.output.dryRun}`)
    if (!config.electricity) console.log('Skipping electricity import: disabled or not configured')
    if (!config.gas) console.log('Skipping gas: gas meter configuration is incomplete')

    do {
        console.log('Polling data from octopus API')
        const points: Point[] = []
        const accounts = new Map<string, Account>()
        const historyStop = new Date()
        let importMpan = config.importMpan
        for (const isExport of [false, true]) {
            const selection = isExport ? config.export : config.electricity
            if (!selection) continue
            let account = accounts.get(selection.account)
            if (!account) {
                account = await client.account(selection.account)
                accounts.set(selection.account, account)
            }
            const meter = selectElectricityMeter(account, {...selection, importMpan}, isExport)
            if (!isExport) importMpan = meter.mpan
            else if (meter.mpan === importMpan) throw new Error('Export MPAN must differ from import MPAN')
            const matches = account.properties.flatMap(property => property.electricity_meter_points)
                .filter(point => point.mpan === meter.mpan && point.is_export === isExport)
            const meterPoint: ElectricityMeterPoint | undefined = matches.length === 1 ? matches[0] : undefined
            if (!meterPoint) throw new Error('Ambiguous electricity agreements for selected meter point')
            if (backfill) {
                const summary: HistorySummary = {readings: 0, priced: 0, batches: 0, earliest: null, latest: null}
                for await (const readings of client.historicalReadings('electricity', meter.mpan, meter.serial, config.pageSize, historyStop)) {
                    const prices = await client.electricityPrices(meterPoint, readings)
                    const batch = electricityPoints(readings, prices, isExport)
                    await outputPoints(batch, config.output)
                    updateSummary(summary, readings, prices, isExport)
                    console.log(`Backfill electricity_${isExport ? 'export' : 'import'}: ${summary.readings} readings processed in ${summary.batches} batches`)
                }
                console.log(`Backfill summary electricity_${isExport ? 'export' : 'import'}: ${JSON.stringify(summary)}`)
            } else {
                const readings = await client.readings('electricity', meter.mpan, meter.serial, config.pageSize)
                const prices = await client.electricityPrices(meterPoint, readings)
                points.push(...electricityPoints(readings, prices, isExport))
            }
        }
        if (config.gas) {
            const meter = config.gas
            if (backfill) {
                const summary: HistorySummary = {readings: 0, priced: null, batches: 0, earliest: null, latest: null}
                for await (const readings of client.historicalReadings('gas', meter.mprn, meter.serial, config.pageSize, historyStop)) {
                    const batch = gasPoints(readings, meter)
                    await outputPoints(batch, config.output)
                    updateSummary(summary, readings)
                    console.log(`Backfill gas: ${summary.readings} readings processed in ${summary.batches} batches`)
                }
                console.log(`Backfill summary gas: ${JSON.stringify(summary)}`)
            } else {
                const readings = await client.readings('gas', meter.mprn, meter.serial, config.pageSize)
                points.push(...gasPoints(readings, meter))
            }
        }
        if (backfill) {
            console.log(`Backfill complete${config.output.dryRun ? ' (dry run; no InfluxDB writes)' : '; all batches submitted to InfluxDB'}`)
            return
        }
        await outputPoints(points, config.output)
        if (config.output.dryRun || config.loopTime === 0) return
        console.log(`Sleeping for: ${config.loopTime}`)
        await sleep(config.loopTime * 1000)
    } while (true)
}

function updateSummary(summary: HistorySummary, readings: Reading[], prices?: AgreementPrices[], isExport = false): void {
    summary.batches++
    summary.readings += readings.length
    for (const reading of readings) {
        if (typeof reading.interval_start !== 'string' || typeof reading.interval_end !== 'string') {
            throw new Error('Invalid historical reading timestamps')
        }
        const start = new Date(reading.interval_start).toISOString()
        const end = new Date(reading.interval_end).toISOString()
        if (prices && summary.priced !== null) {
            const price = intervalPrices(prices, new Date(start), new Date(end), isExport)
            if (price.unitRate !== undefined && (isExport || price.dailyStandingCharge !== undefined)) summary.priced++
        }
        if (summary.earliest === null || start < summary.earliest) summary.earliest = start
        if (summary.latest === null || end > summary.latest) summary.latest = end
    }
}

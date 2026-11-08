const assert = require('node:assert/strict')
const {test} = require('node:test')
const http = require('node:http')
const {spawnSync} = require('node:child_process')
const {tmpdir} = require('node:os')
const path = require('node:path')
const {setImmediate} = require('node:timers/promises')
const {InfluxDB} = require('@influxdata/influxdb-client')
const {boot} = require('../dist/collector')
const {electricityPoints, gasPoints} = require('../dist/points')
const {intervalPrices} = require('../dist/pricing')
const {OctopusClient, OctopusRequestError} = require('../dist/octopus')
const {readConfig} = require('../dist/config')
const {selectElectricityMeter} = require('../dist/discovery')

const reading = {consumption: 1.25, interval_start: '2026-10-24T12:00:00Z', interval_end: '2026-10-24T12:30:00Z'}
const timestamp = `${Date.parse(reading.interval_end)}000000`
const base = {OCTO_API_KEY: 'test-api-key', DRY_RUN: 'true'}
const importConfig = {OCTO_ACCOUNT_NUMBER: 'A-main', OCTO_ELECTRIC_MPAN: 'import', OCTO_ELECTRIC_SN: 'serial'}
const exportConfig = {
    OCTO_ELECTRIC_ENABLED: 'false', OCTO_EXPORT_ENABLED: 'true',
    OCTO_EXPORT_ACCOUNT_NUMBER: 'A-main', OCTO_EXPORT_MPAN: 'export', OCTO_EXPORT_SN: 'serial'
}
const gasConfig = {
    OCTO_GAS_MPRN: 'gas', OCTO_GAS_SN: 'serial', OCTO_GAS_COST: '10',
    VOLUME_CORRECTION: '1.02264', CALORIFIC_VALUE: '37.5', JOULES_CONVERSION: '3.6'
}
const agreement = (tariff = 'E-1R-IMPORT-26-01-01-A', from = '2026-01-01T00:00:00Z', to = null) =>
    ({tariff_code: tariff, valid_from: from, valid_to: to})
const period = (value, from = '2026-01-01T00:00:00Z', to = null, method = null) => ({
    valid_from: from, valid_to: to, value_inc_vat: value, value_exc_vat: value, payment_method: method
})
const entry = (unit = 20, standing = 48, a = agreement()) =>
    ({agreement: a, unitRates: [period(unit)], standingCharges: [period(standing)]})
const meterPoint = (mpan, is_export = false, serials = ['serial']) => ({
    mpan, is_export, meters: serials.map(serial_number => ({serial_number})),
    agreements: [agreement(is_export ? 'E-1R-OUTGOING-26-01-01-A' : 'E-1R-IMPORT-26-01-01-A')]
})
const property = (points, extra = {}) => ({
    moved_in_at: '2020-01-01T00:00:00Z', moved_out_at: null, electricity_meter_points: points, ...extra
})
const account = {properties: [property([meterPoint('import'), meterPoint('export', true)])]}

function capture(t) {
    const lines = [], warnings = []
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')))
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')))
    return {lines, warnings}
}

function mockApi(t, handler) {
    return t.mock.method(globalThis, 'fetch', async (url, options) => {
        const override = handler?.(url, options)
        if (override !== undefined) return override
        if (url.includes('/accounts/')) return Response.json(account)
        if (url.includes('/consumption/')) return Response.json({results: [reading]})
        if (url.includes('/standing-charges/')) return Response.json({results: [period(48)], next: null})
        if (url.includes('/standard-unit-rates/')) {
            return Response.json({results: [period(url.includes('OUTGOING') ? 15 : 20)], next: null})
        }
        assert.fail('Unexpected API request')
    })
}

function fields(point) {
    return point.toLineProtocol().split(' ')[1].split(',').sort()
}

test('API-priced export dry run emits revenue and never creates an Influx writer', async t => {
    const {lines} = capture(t)
    const get = mockApi(t)
    t.mock.method(InfluxDB.prototype, 'getWriteApi', () => assert.fail('No dry-run writer'))
    await boot({...base, ...exportConfig})
    assert.equal(get.mock.callCount(), 3)
    const line = lines.find(line => line.startsWith('electricity_export,'))
    assert.ok(line.includes('energy_kwh=1.25'))
    assert.ok(line.includes('unit_rate_gbp_per_kwh=0.15'))
    assert.ok(line.includes('revenue_gbp=0.1875'))
    assert.ok(line.includes('unit_rate_available=T'))
    assert.ok(line.endsWith(timestamp))
    assert.ok(!line.includes('standing_charge'))
    assert.ok(lines.every(line => !line.includes(base.OCTO_API_KEY)))
    assert.ok(lines.some(line => line.includes('Dry run complete: 1 points')))
})

test('import and export share one account request, discover meters, and keep gas compatible', async t => {
    const {lines} = capture(t)
    const get = mockApi(t)
    await boot({...base, ...importConfig, OCTO_EXPORT_ENABLED: 'true', ...gasConfig})
    assert.equal(get.mock.calls.filter(call => call.arguments[0].includes('/accounts/')).length, 1)
    const line = lines.find(line => line.startsWith('electricity_import,'))
    assert.ok(line.includes('energy_kwh=1.25'))
    assert.ok(line.includes('usage_cost_gbp=0.25'))
    assert.ok(line.includes('total_cost_gbp=0.26'))
    assert.ok(line.includes('standing_charge_available=T'))
    const kwh = 1.25 * 1.02264 * 37.5 / 3.6
    assert.ok(lines.includes(`gas,app=octopus-energy-consumption-metrics consumption=1.25 ${timestamp}`))
    assert.ok(lines.includes(`gaskwh,app=octopus-energy-consumption-metrics consumption_kwh=${kwh} ${timestamp}`))
    assert.ok(lines.includes(`gas_cost,app=octopus-energy-consumption-metrics price=${kwh * 10 / 100} ${timestamp}`))
    assert.equal(lines.filter(line => /^(electricity|gas)/.test(line)).length, 5)
})

test('missing rates emit warnings and energy with false availability, not invented prices', async t => {
    const {lines, warnings} = capture(t)
    mockApi(t, url => url.includes('/standard-unit-rates/') || url.includes('/standing-charges/')
        ? Response.json({results: []}) : undefined)
    await boot({...base, ...importConfig, OCTO_EXPORT_ENABLED: 'true'})
    const imported = lines.find(line => line.startsWith('electricity_import,'))
    const exported = lines.find(line => line.startsWith('electricity_export,'))
    for (const line of [imported, exported]) {
        assert.ok(line.includes('energy_kwh=1.25'))
        assert.ok(line.includes('unit_rate_available=F'))
        assert.ok(!line.includes('unit_rate_gbp_per_kwh='))
        assert.ok(!line.includes('total_cost_gbp='))
        assert.ok(!line.includes('revenue_gbp='))
    }
    assert.ok(imported.includes('standing_charge_available=F'))
    assert.equal(warnings.length, 3)
})

test('partial pricing retains available standing charge or usage independently', t => {
    capture(t)
    const noUnit = entry()
    noUnit.unitRates = []
    const noStanding = entry()
    noStanding.standingCharges = []
    const standingOnly = fields(electricityPoints([reading], [noUnit])[0])
    assert.ok(standingOnly.includes('standing_charge_available=T'))
    assert.ok(standingOnly.includes('daily_standing_charge_gbp=0.48'))
    assert.ok(!standingOnly.some(field => field.startsWith('usage_cost_gbp=')))
    const usageOnly = fields(electricityPoints([reading], [noStanding])[0])
    assert.ok(usageOnly.includes('usage_cost_gbp=0.25'))
    assert.ok(!usageOnly.some(field => field.startsWith('total_cost_gbp=')))
})

test('rates match interval start, not the rate of the following half-hour', () => {
    const prices = entry()
    prices.unitRates = [
        period(20, '2026-10-24T12:00:00Z', '2026-10-24T12:30:00Z'),
        period(40, '2026-10-24T12:30:00Z', '2026-10-24T13:00:00Z')
    ]
    assert.equal(intervalPrices([prices], new Date(reading.interval_start), new Date(reading.interval_end), false).unitRate, 0.2)
})

test('historical agreement changes use the correct product and tariff for each interval', async t => {
    capture(t)
    const boundary = '2026-10-24T12:30:00Z'
    const point = meterPoint('import')
    point.agreements = [
        agreement('E-1R-OLD-25-01-01-A', '2025-01-01T00:00:00Z', boundary),
        agreement('E-1R-NEW-26-10-24-A', boundary)
    ]
    const later = {...reading, interval_start: boundary, interval_end: '2026-10-24T13:00:00Z'}
    const get = mockApi(t, url => url.includes('/standard-unit-rates/')
        ? Response.json({results: [period(url.includes('/OLD-') ? 10 : 30)]}) : undefined)
    const prices = await new OctopusClient('test').electricityPrices(point, [reading, later])
    const points = electricityPoints([reading, later], prices)
    assert.ok(fields(points[0]).includes('unit_rate_gbp_per_kwh=0.1'))
    assert.ok(fields(points[1]).includes('unit_rate_gbp_per_kwh=0.3'))
    const urls = get.mock.calls.map(call => new URL(call.arguments[0]))
    assert.ok(urls.some(url => url.pathname.includes('/products/OLD-25-01-01/electricity-tariffs/E-1R-OLD-25-01-01-A/')))
    assert.ok(urls.some(url => url.searchParams.get('period_from') === '2026-10-24T12:30:00.000Z'))
    assert.ok(urls.some(url => url.searchParams.get('period_to') === '2026-10-24T12:30:00.000Z'))
})

test('tariff pagination retrieves all rates and preserves negative and zero values', async t => {
    capture(t)
    const next = 'https://api.octopus.energy/v1/products/test/rates/?page=2'
    const get = mockApi(t, url => url === next
        ? Response.json({results: [period(-5)], next: null})
        : url.includes('/standard-unit-rates/')
            ? Response.json({results: [period(0)], next}) : undefined)
    const prices = await new OctopusClient('test').electricityPrices(meterPoint('export', true), [reading])
    assert.deepEqual(prices[0].unitRates.map(rate => rate.value_exc_vat), [0, -5])
    assert.equal(get.mock.callCount(), 2)
    for (const value of [0, -5]) {
        const line = electricityPoints([reading], [entry(value)], true)[0].toLineProtocol()
        assert.ok(line.includes(`revenue_gbp=${1.25 * value / 100}`))
        assert.ok(line.includes('unit_rate_available=T'))
    }
})

test('pagination refuses foreign origins and repeated pages before sending credentials', async t => {
    capture(t)
    const get = mockApi(t, url => url.includes('/standard-unit-rates/')
        ? Response.json({results: [], next: 'https://example.com/steal'}) : undefined)
    const client = new OctopusClient('test-key')
    await assert.rejects(client.electricityPrices(meterPoint('export', true), [reading]), /outside the API origin/)
    assert.equal(get.mock.callCount(), 1)
    mockApi(t, url => Response.json({results: [], next: url}))
    await assert.rejects(client.electricityPrices(meterPoint('export', true), [reading]), /Repeated/)
})

test('export uses API VAT-exclusive payments, import uses API VAT-inclusive costs', () => {
    const prices = entry()
    prices.unitRates = [{...period(21), value_exc_vat: 20}]
    const start = new Date(reading.interval_start), end = new Date(reading.interval_end)
    assert.equal(intervalPrices([prices], start, end, false).unitRate, 0.21)
    assert.equal(intervalPrices([prices], start, end, true).unitRate, 0.2)
})

test('payment method null works; import prefers direct debit; conflicts and other methods are unavailable', () => {
    const prices = entry()
    const start = new Date(reading.interval_start), end = new Date(reading.interval_end)
    prices.unitRates = [period(10), period(20, undefined, null, 'DIRECT_DEBIT')]
    assert.equal(intervalPrices([prices], start, end, false).unitRate, 0.2)
    assert.equal(intervalPrices([prices], start, end, true).unitRate, 0.1)
    prices.unitRates.push(period(30, undefined, null, 'DIRECT_DEBIT'))
    assert.equal(intervalPrices([prices], start, end, false).unitRate, undefined)
    prices.unitRates = [period(30, undefined, null, 'PREPAYMENT')]
    assert.equal(intervalPrices([prices], start, end, false).unitRate, undefined)
})

test('gaps, interval-spanning rate changes, ambiguous agreements and invalid prices are unpriced', () => {
    const start = new Date(reading.interval_start), end = new Date(reading.interval_end)
    assert.deepEqual(intervalPrices([], start, end, false), {})
    assert.deepEqual(intervalPrices([entry(), entry()], start, end, false), {})
    for (const rates of [
        [period(10, '2026-10-24T12:15:00Z')],
        [period(10, undefined, '2026-10-24T12:15:00Z')],
        [{...period(20), value_inc_vat: null}]
    ]) {
        assert.equal(intervalPrices([{...entry(), unitRates: rates}], start, end, false).unitRate, undefined)
    }
})

test('DST repeated wall-clock intervals select different rates by absolute time', () => {
    const prices = entry()
    prices.unitRates = [
        period(10, '2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'),
        period(30, '2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z')
    ]
    const first = intervalPrices([prices], new Date('2026-10-25T01:00:00+01:00'), new Date('2026-10-25T01:30:00+01:00'), false)
    const second = intervalPrices([prices], new Date('2026-10-25T01:00:00Z'), new Date('2026-10-25T01:30:00Z'), false)
    assert.equal(first.unitRate, 0.1)
    assert.equal(second.unitRate, 0.3)
})

test('duration and standing-charge allocation use actual interval length', () => {
    const hour = {...reading, interval_end: '2026-10-24T13:00:00Z'}
    const result = fields(electricityPoints([hour], [entry()])[0])
    assert.ok(result.includes('interval_seconds=3600'))
    assert.ok(result.includes('standing_charge_gbp=0.02'))
})

test('rate HTTP errors are explicit warnings and do not discard energy', async t => {
    const {lines, warnings} = capture(t)
    mockApi(t, url => url.includes('/standard-unit-rates/') ? new Response('private', {status: 503}) : undefined)
    await boot({...base, ...exportConfig})
    assert.ok(warnings.some(line => line.includes('HTTP 503')))
    assert.ok(lines.some(line => line.includes('unit_rate_available=F')))
    assert.ok(warnings.every(line => !line.includes('private')))
})

test('rate timeout preserves energy with warnings; account/readings errors still fail', async t => {
    const {warnings} = capture(t)
    mockApi(t, url => {
        if (url.includes('/standard-unit-rates/')) throw new DOMException('Timed out', 'TimeoutError')
    })
    await boot({...base, ...exportConfig})
    assert.ok(warnings.some(line => line.includes('TimeoutError')))
    mockApi(t, url => url.includes('/accounts/') ? new Response('', {status: 401}) : undefined)
    await assert.rejects(boot({...base, ...exportConfig}), /HTTP 401/)
})

test('unsupported multi-register tariffs remain explicitly unpriced', async t => {
    const {warnings} = capture(t)
    const get = mockApi(t)
    const point = {...meterPoint('import'), agreements: [agreement('E-2R-ECONOMY-26-01-01-A')]}
    const prices = await new OctopusClient('test').electricityPrices(point, [reading])
    assert.equal(get.mock.callCount(), 0)
    assert.equal(prices[0].unitRates.length, 0)
    assert.ok(warnings.some(line => line.includes('single-register')))
})

test('discovery distinguishes directions and ignores moved-out or future properties', () => {
    const data = {properties: [
        property([meterPoint('old', true)], {moved_out_at: '2025-01-01T00:00:00Z'}),
        property([meterPoint('future', true)], {moved_in_at: '2027-01-01T00:00:00Z'}),
        ...account.properties
    ]}
    const now = new Date('2026-10-24')
    assert.deepEqual(selectElectricityMeter(data, {}, false, now), {mpan: 'import', serial: 'serial'})
    assert.deepEqual(selectElectricityMeter(data, {}, true, now), {mpan: 'export', serial: 'serial'})
})

test('discovery prefers import property but explicit MPAN takes precedence', () => {
    const data = {properties: [...account.properties, property([meterPoint('other', true)])]}
    assert.deepEqual(selectElectricityMeter(data, {importMpan: 'import'}, true), {mpan: 'export', serial: 'serial'})
    assert.deepEqual(selectElectricityMeter(data, {importMpan: 'import', mpan: 'other'}, true), {mpan: 'other', serial: 'serial'})
})

test('ambiguous meters/serials and missing registrations fail rather than guess', () => {
    const data = {properties: [property([meterPoint('export', true, ['old', 'new'])])]}
    assert.throws(() => selectElectricityMeter(data, {}, true), /Multiple export meters/)
    assert.throws(() => selectElectricityMeter(data, {}, false), /No matching import meter/)
    assert.deepEqual(selectElectricityMeter(data, {serial: 'new'}, true), {mpan: 'export', serial: 'new'})
})

test('export-only and separate-account collection do not accidentally enable import', async t => {
    capture(t)
    const get = mockApi(t)
    await boot({...base, ...exportConfig, OCTO_EXPORT_ACCOUNT_NUMBER: 'A-export', OCTO_ACCOUNT_NUMBER: 'A-main'})
    assert.ok(get.mock.calls[0].arguments[0].includes('/accounts/A-export/'))
    assert.ok(get.mock.calls.every(call => !call.arguments[0].includes('/meters/serial/consumption/') ||
        call.arguments[0].includes('/export/')))
})

test('removed manual electricity settings warn and cannot override API rates', async t => {
    const {lines, warnings} = capture(t)
    mockApi(t)
    await boot({...base, ...importConfig, OCTO_ELECTRIC_COST: '900', OCTO_ELECTRIC_STANDING_CHARGE: '999', OCTO_ELECTRIC_PRODUCT_CODE: 'WRONG'})
    assert.ok(warnings.some(line => line.includes('settings are ignored')))
    assert.ok(lines.find(line => line.startsWith('electricity_import,')).includes('unit_rate_gbp_per_kwh=0.2'))
})

test('configuration validates accounts, enable flags, timeouts and page sizes', t => {
    capture(t)
    assert.equal(readConfig({...base, OCTO_ACCOUNT_NUMBER: 'A-main'}).electricity.account, 'A-main')
    assert.equal(readConfig({...base, ...exportConfig}).electricity, undefined)
    assert.throws(() => readConfig({...base, OCTO_ELECTRIC_MPAN: 'import'}), /require OCTO_ACCOUNT_NUMBER/)
    assert.throws(() => readConfig({...base, OCTO_EXPORT_ENABLED: 'true'}), /Export.*require/)
    assert.throws(() => readConfig(base), /No meters enabled/)
    assert.throws(() => readConfig({...base, ...exportConfig, DRY_RUN: 'false'}), /INFLUXDB_BUCKET/)
    assert.equal(readConfig({...base, ...exportConfig}).timeoutSeconds, 60)
    for (const [key, values] of Object.entries({
        PAGE_SIZE: ['0', '25001', '-1'], OCTO_TIMEOUT_SECONDS: ['0', '-1', '2147484'],
        LOOP_TIME: ['-1'], OCTO_EXPORT_ENABLED: ['typo'], OCTO_ELECTRIC_ENABLED: ['typo']
    })) {
        for (const value of values) assert.throws(() => readConfig({...base, ...exportConfig, [key]: value}), new RegExp(key))
    }
})

test('gas configuration and conversion remain unchanged', () => {
    const config = readConfig({...base, ...gasConfig})
    const lines = gasPoints([reading], config.gas).map(point => point.toLineProtocol())
    assert.equal(lines.length, 3)
    assert.ok(lines[0].includes('consumption=1.25'))
    assert.throws(() => readConfig({...base, ...gasConfig, JOULES_CONVERSION: '0'}), /JOULES_CONVERSION/)
    assert.throws(() => readConfig({...base, ...gasConfig, OCTO_GAS_COST: 'invalid'}), /OCTO_GAS_COST/)
})

test('invalid reading values and reversed intervals fail explicitly', t => {
    capture(t)
    for (const bad of [
        {...reading, consumption: null}, {...reading, consumption: ''}, {...reading, consumption: 'invalid'},
        {...reading, interval_start: null}, {...reading, interval_end: 'invalid'},
        {...reading, interval_end: reading.interval_start}
    ]) {
        assert.throws(() => electricityPoints([bad], [entry()]), /Invalid/)
    }
    assert.ok(fields(electricityPoints([{...reading, consumption: 0}], [entry()])[0]).includes('energy_kwh=0'))
})

test('empty readings skip rate requests and dry run exits after one poll', async t => {
    const {lines} = capture(t)
    const get = mockApi(t, url => url.includes('/consumption/') ? Response.json({results: []}) : undefined)
    await boot({...base, ...exportConfig, LOOP_TIME: '999'})
    assert.equal(get.mock.callCount(), 2)
    assert.ok(lines.some(line => line.includes('Dry run complete: 0 points')))
})

test('HTTP boundary encodes identifiers, authenticates safely and uses configurable timeout', async t => {
    const get = mockApi(t)
    const timeout = t.mock.method(AbortSignal, 'timeout')
    await new OctopusClient('test-key', 120).readings('electricity', 'mpan/one', 'serial two', 100)
    assert.ok(get.mock.calls[0].arguments[0].includes('/mpan%2Fone/meters/serial%20two/'))
    assert.equal(timeout.mock.calls[0].arguments[0], 120000)
    assert.equal(get.mock.calls[0].arguments[1].headers.Authorization, `Basic ${Buffer.from('test-key:').toString('base64')}`)
    assert.equal(get.mock.calls[0].arguments[1].redirect, 'error')
})

test('malformed response shapes fail instead of pretending there are no readings or accounts', async t => {
    mockApi(t, () => Response.json({results: null}))
    const client = new OctopusClient('test')
    await assert.rejects(client.readings('gas', 'gas', 'serial', 48), /results array/)
    await assert.rejects(client.account('A-main'), /properties array/)
})

test('HTTP failures have safe messages without response bodies or identifiers', async t => {
    mockApi(t, () => new Response('private body', {status: 403}))
    await assert.rejects(new OctopusClient('test').account('private-account'),
        {message: 'Octopus API returned HTTP 403'})
    assert.ok(OctopusRequestError.prototype instanceof Error)
})

test('normal mode writes new import/export schema to a real local Influx HTTP endpoint', async t => {
    capture(t)
    mockApi(t)
    const requests = []
    const server = http.createServer((req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            requests.push({url: req.url, body, auth: req.headers.authorization})
            res.writeHead(204).end()
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    await boot({
        ...base, ...importConfig, OCTO_EXPORT_ENABLED: 'true', DRY_RUN: 'false', LOOP_TIME: '0',
        INFLUXDB_URL: `http://127.0.0.1:${server.address().port}`,
        INFLUXDB_TOKEN: 'test-token', INFLUXDB_ORG: 'test-org', INFLUXDB_BUCKET: 'test-bucket'
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].auth, 'Token test-token')
    assert.equal(requests[0].body.trim().split('\n').length, 2)
    assert.match(requests[0].url, /precision=ns/)
    assert.ok(requests[0].body.includes('electricity_import,'))
    assert.ok(requests[0].body.includes('revenue_gbp=0.1875'))
    assert.ok(requests[0].body.includes(timestamp))
})

test('Influx failures propagate without a false success message', async t => {
    const {lines} = capture(t)
    mockApi(t)
    t.mock.method(InfluxDB.prototype, 'getWriteApi', () => ({
        writePoints() {}, async close() { throw new Error('Influx rejected') }
    }))
    await assert.rejects(boot({
        ...base, ...exportConfig, DRY_RUN: 'false', LOOP_TIME: '0',
        INFLUXDB_URL: 'http://localhost:8086', INFLUXDB_TOKEN: 'test-token',
        INFLUXDB_ORG: 'test-org', INFLUXDB_BUCKET: 'test-bucket'
    }), /Influx rejected/)
    assert.ok(lines.every(line => !line.includes('submitted to InfluxDB successfully')))
})

test('CLI accepts dry-run without Influx settings and rejects unknown arguments', () => {
    const script = path.join(__dirname, '../dist/cli.js')
    const run = args => spawnSync(process.execPath, [script, ...args], {
        cwd: tmpdir(), env: {OCTO_API_KEY: 'test-key'}, encoding: 'utf8'
    })
    const dry = run(['--dry-run'])
    assert.equal(dry.status, 1)
    assert.match(dry.stderr, /No meters enabled/)
    assert.doesNotMatch(dry.stdout + dry.stderr, /test-key|INFLUXDB_BUCKET.*required/)
    assert.match(run(['--bad']).stderr, /Unknown arguments/)
})

test('polling remains asynchronous and refreshes agreements on each poll', async t => {
    capture(t)
    t.mock.timers.enable({apis: ['setTimeout']})
    let accounts = 0
    mockApi(t, url => {
        if (url.includes('/accounts/') && ++accounts === 2) throw new Error('Stop polling')
    })
    t.mock.method(InfluxDB.prototype, 'getWriteApi', () => ({writePoints() {}, async close() {}}))
    const running = boot({
        ...base, ...exportConfig, DRY_RUN: 'false', LOOP_TIME: '1',
        INFLUXDB_URL: 'http://localhost:8086', INFLUXDB_TOKEN: 'test-token',
        INFLUXDB_ORG: 'test-org', INFLUXDB_BUCKET: 'test-bucket'
    })
    await setImmediate()
    assert.equal(accounts, 1)
    t.mock.timers.tick(999)
    await setImmediate()
    assert.equal(accounts, 1)
    const stopped = assert.rejects(running, /Stop polling/)
    t.mock.timers.tick(1)
    await stopped
    assert.equal(accounts, 2)
})

test('historical readings explicitly request all time and follow pages even beyond PAGE_SIZE', async t => {
    const stop = new Date('2026-10-25T12:00:00Z')
    const next = 'https://api.octopus.energy/v1/history/?page=2'
    const later = {...reading, interval_start: '2026-10-24T12:30:00Z', interval_end: '2026-10-24T13:00:00Z'}
    const get = mockApi(t, url => url.includes('/consumption/')
        ? Response.json({results: [reading], next})
        : url === next ? Response.json({results: [later], next: null}) : undefined)
    const pages = []
    for await (const page of new OctopusClient('test').historicalReadings('electricity', 'import', 'serial', 1, stop)) {
        pages.push(page)
    }
    assert.deepEqual(pages, [[reading], [later]])
    const url = new URL(get.mock.calls[0].arguments[0])
    assert.equal(url.searchParams.get('period_from'), '1970-01-01T00:00:00Z')
    assert.equal(url.searchParams.get('period_to'), stop.toISOString())
    assert.equal(url.searchParams.get('order_by'), 'period')
    assert.equal(url.searchParams.get('page_size'), '1')
})

test('backfill dry run processes both directions, all pages and reports coverage without writing', async t => {
    const {lines} = capture(t)
    const next = 'https://api.octopus.energy/v1/history/?page=2'
    const later = {...reading, interval_start: '2026-10-24T12:30:00Z', interval_end: '2026-10-24T13:00:00Z'}
    mockApi(t, url => url.includes('/consumption/')
        ? Response.json({results: [reading], next})
        : url === next ? Response.json({results: [later], next: null}) : undefined)
    t.mock.method(InfluxDB.prototype, 'getWriteApi', () => assert.fail('No dry-run writer'))
    await boot({...base, ...importConfig, OCTO_EXPORT_ENABLED: 'true', PAGE_SIZE: '1', LOOP_TIME: '999'}, true)
    for (const direction of ['import', 'export']) {
        const line = lines.find(line => line.startsWith(`Backfill summary electricity_${direction}: `))
        const summary = JSON.parse(line.slice(line.indexOf(': ') + 2))
        assert.deepEqual(summary, {
            readings: 2, priced: 2, batches: 2,
            earliest: '2026-10-24T12:00:00.000Z', latest: '2026-10-24T13:00:00.000Z'
        })
        assert.equal(lines.filter(line => line.startsWith(`electricity_${direction},`)).length, 2)
    }
    assert.ok(lines.includes('Backfill complete (dry run; no InfluxDB writes)'))
})

test('backfill flushes each batch and stops with partial progress if a later write fails', async t => {
    const {lines} = capture(t)
    const next = 'https://api.octopus.energy/v1/history/?page=2'
    mockApi(t, url => url.includes('/consumption/')
        ? Response.json({results: [reading], next})
        : url === next ? Response.json({results: [reading], next: null}) : undefined)
    let writes = 0, closes = 0
    t.mock.method(InfluxDB.prototype, 'getWriteApi', () => ({
        writePoints(points) { writes++; assert.equal(points.length, 1) },
        async close() { closes++; if (closes === 2) throw new Error('Batch rejected') }
    }))
    await assert.rejects(boot({
        ...base, ...exportConfig, DRY_RUN: 'false', INFLUXDB_URL: 'http://localhost:8086',
        INFLUXDB_TOKEN: 'test', INFLUXDB_ORG: 'test', INFLUXDB_BUCKET: 'test'
    }, true), /Batch rejected/)
    assert.equal(writes, 2)
    assert.equal(closes, 2)
    assert.ok(lines.some(line => line.includes('1 readings processed in 1 batches')))
    assert.ok(lines.every(line => !line.startsWith('Backfill complete')))
})

test('backfill reports empty history and unpriced intervals honestly', async t => {
    const {lines, warnings} = capture(t)
    mockApi(t, url => url.includes('/standard-unit-rates/') ? Response.json({results: []}) : undefined)
    await boot({...base, ...exportConfig}, true)
    assert.ok(lines.some(line => line.includes('"readings":1,"priced":0')))
    assert.ok(warnings.length > 0)
    lines.length = 0
    mockApi(t, url => url.includes('/consumption/') ? Response.json({results: [], next: null}) : undefined)
    await boot({...base, ...exportConfig}, true)
    assert.ok(lines.some(line => line.includes('"readings":0,"priced":0') && line.includes('"earliest":null')))
})

test('historical reading pagination validates pages, loop detection, and foreign origins', async t => {
    const client = new OctopusClient('test')
    async function drain() {
        for await (const page of client.historicalReadings('gas', 'gas', 'serial', 48, new Date())) {
            assert.ok(Array.isArray(page))
        }
    }
    mockApi(t, url => Response.json({results: [], next: url}))
    await assert.rejects(drain(), /Repeated/)
    mockApi(t, () => Response.json({results: [], next: 'https://example.com/private'}))
    await assert.rejects(drain(), /outside the API origin/)
    mockApi(t, () => Response.json({results: [], next: 4}))
    await assert.rejects(drain(), /expected next URL/)
    mockApi(t, () => Response.json({results: null}))
    await assert.rejects(drain(), /expected results array/)
})

test('gas backfill processes all historical batches without changing legacy fields', async t => {
    const {lines} = capture(t)
    const get = mockApi(t)
    await boot({...base, ...gasConfig}, true)
    assert.equal(lines.filter(line => /^(gas|gaskwh|gas_cost),/.test(line)).length, 3)
    assert.ok(lines.some(line => line.includes('Backfill summary gas: {"readings":1,"priced":null')))
    assert.ok(new URL(get.mock.calls[0].arguments[0]).searchParams.has('period_from'))
})

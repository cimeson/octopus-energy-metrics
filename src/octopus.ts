import type {Account, AgreementPrices, ElectricityMeterPoint, PricePeriod, Reading} from './types.js'

const API_URL = 'https://api.octopus.energy/v1'

export class OctopusRequestError extends Error {}

interface Page<T> {
    results: T[]
    next?: string | null
}

export class OctopusClient {
    constructor(private readonly apiKey: string, private readonly timeoutSeconds = 60) {}

    private async get<T>(url: string): Promise<T> {
        if (new URL(url).origin !== 'https://api.octopus.energy') {
            throw new Error('Refusing an Octopus pagination URL outside the API origin')
        }
        try {
            const response = await fetch(url, {
                headers: {Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`},
                signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
                redirect: 'error'
            })
            if (!response.ok) {
                await response.body?.cancel()
                throw new OctopusRequestError(`Octopus API returned HTTP ${response.status}`)
            }
            return await response.json()
        } catch (error: unknown) {
            if (error instanceof Error && ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'].includes(error.name)) {
                throw new OctopusRequestError(`Octopus request failed (${error.name})`)
            }
            throw error
        }
    }

    async account(number: string): Promise<Account> {
        const account = await this.get<Account>(`${API_URL}/accounts/${encodeURIComponent(number)}/`)
        if (!Array.isArray(account.properties)) throw new Error('Invalid account response: expected properties array')
        return account
    }

    async readings(fuel: 'electricity' | 'gas', meterPoint: string, serial: string, pageSize: number): Promise<Reading[]> {
        const response = await this.get<Page<Reading>>(
            `${API_URL}/${fuel}-meter-points/${encodeURIComponent(meterPoint)}/meters/${encodeURIComponent(serial)}/consumption/?page_size=${pageSize}`)
        if (!Array.isArray(response.results)) {
            throw new Error(`Invalid ${fuel} readings response: expected results array`)
        }
        return response.results
    }

    private async *pages<T>(url: string): AsyncGenerator<T[]> {
        const visited = new Set<string>()
        let next: string | null | undefined = url
        while (next) {
            if (visited.has(next)) throw new Error('Repeated Octopus pagination URL')
            visited.add(next)
            const page: Page<T> = await this.get<Page<T>>(next)
            if (!Array.isArray(page.results)) throw new Error('Invalid paginated response: expected results array')
            if (page.next !== undefined && page.next !== null && typeof page.next !== 'string') {
                throw new Error('Invalid paginated response: expected next URL or null')
            }
            yield page.results
            next = page.next
        }
    }

    async *historicalReadings(fuel: 'electricity' | 'gas', meterPoint: string, serial: string, pageSize: number, stop: Date): AsyncGenerator<Reading[]> {
        const query = new URLSearchParams({
            page_size: String(pageSize),
            period_from: '1970-01-01T00:00:00Z',
            period_to: stop.toISOString(),
            order_by: 'period'
        })
        yield* this.pages<Reading>(
            `${API_URL}/${fuel}-meter-points/${encodeURIComponent(meterPoint)}/meters/${encodeURIComponent(serial)}/consumption/?${query}`)
    }

    private async rates(url: string): Promise<PricePeriod[]> {
        const rates: PricePeriod[] = []
        for await (const page of this.pages<PricePeriod>(url)) rates.push(...page)
        return rates
    }

    async electricityPrices(meter: ElectricityMeterPoint, readings: Reading[]): Promise<AgreementPrices[]> {
        if (!readings.length) return []
        const starts = readings.map(reading => typeof reading.interval_start === 'string' ? Date.parse(reading.interval_start) : NaN)
        const ends = readings.map(reading => typeof reading.interval_end === 'string' ? Date.parse(reading.interval_end) : NaN)
        if ([...starts, ...ends].some(value => !Number.isFinite(value))) {
            throw new Error('Invalid electricity reading interval')
        }
        const from = Math.min(...starts)
        const to = Math.max(...ends)
        const prices: AgreementPrices[] = []
        for (const agreement of meter.agreements) {
            const start = Date.parse(agreement.valid_from)
            const end = agreement.valid_to === null ? Infinity : Date.parse(agreement.valid_to)
            if (!Number.isFinite(start) || Number.isNaN(end) || end <= start) {
                throw new Error('Invalid electricity agreement validity period')
            }
            if (start >= to || end <= from) continue
            const match = /^E-1R-(.+)-[A-Z]$/.exec(agreement.tariff_code)
            const product = match?.[1]
            const entry: AgreementPrices = {agreement, standingCharges: [], unitRates: []}
            prices.push(entry)
            if (!product) {
                console.warn('Electricity pricing unavailable: only single-register standard-unit-rate tariffs are supported')
                continue
            }
            const query = new URLSearchParams({
                period_from: new Date(Math.max(start, from)).toISOString(),
                period_to: new Date(Math.min(end, to)).toISOString(),
                page_size: '1500'
            })
            const base = `${API_URL}/products/${encodeURIComponent(product)}/electricity-tariffs/${encodeURIComponent(agreement.tariff_code)}`
            for (const kind of meter.is_export ? ['standard-unit-rates'] : ['standard-unit-rates', 'standing-charges']) {
                try {
                    const rates = await this.rates(`${base}/${kind}/?${query}`)
                    if (kind === 'standard-unit-rates') entry.unitRates = rates
                    else entry.standingCharges = rates
                } catch (error: unknown) {
                    if (!(error instanceof OctopusRequestError)) throw error
                    console.warn(`Electricity ${meter.is_export ? 'export' : 'import'} ${kind} unavailable: ${error.message}`)
                }
            }
        }
        return prices
    }
}

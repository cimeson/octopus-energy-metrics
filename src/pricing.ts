import type {AgreementPrices, PricePeriod} from './types.js'

function covers(from: string, to: string | null, start: Date, end: Date): boolean {
    return Date.parse(from) <= start.valueOf() && (to === null || Date.parse(to) >= end.valueOf())
}

function rate(periods: PricePeriod[], start: Date, end: Date, isExport: boolean): number | undefined {
    const matching = periods.filter(period =>
        covers(period.valid_from, period.valid_to, start, end) &&
        (period.payment_method === null || period.payment_method === 'DIRECT_DEBIT'))
    const preferred = matching.filter(period => period.payment_method === (isExport ? null : 'DIRECT_DEBIT'))
    const candidates = preferred.length ? preferred : matching
    const values = candidates.map(period => isExport ? period.value_exc_vat : period.value_inc_vat)
    if (!values.length || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) return undefined
    const unique = [...new Set(values)]
    return unique.length === 1 && unique[0] !== undefined ? unique[0] / 100 : undefined
}

export function intervalPrices(prices: AgreementPrices[], start: Date, end: Date, isExport: boolean): {
    unitRate?: number
    dailyStandingCharge?: number
    tariffCode?: string
} {
    const agreements = prices.filter(entry =>
        covers(entry.agreement.valid_from, entry.agreement.valid_to, start, end))
    const entry = agreements.length === 1 ? agreements[0] : undefined
    if (!entry) return {}
    return {
        tariffCode: entry.agreement.tariff_code,
        unitRate: rate(entry.unitRates, start, end, isExport),
        dailyStandingCharge: isExport ? undefined : rate(entry.standingCharges, start, end, false)
    }
}

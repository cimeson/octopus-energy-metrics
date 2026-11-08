export interface Meter {
    mpan: string
    serial: string
}

export interface Reading {
    consumption: unknown
    interval_start: unknown
    interval_end: unknown
}

export interface PricePeriod {
    payment_method: string | null
    valid_from: string
    valid_to: string | null
    value_inc_vat: number
    value_exc_vat: number
}

export interface Agreement {
    tariff_code: string
    valid_from: string
    valid_to: string | null
}

export interface AgreementPrices {
    agreement: Agreement
    standingCharges: PricePeriod[]
    unitRates: PricePeriod[]
}

export interface ElectricityMeterPoint {
    mpan: string
    is_export: boolean
    meters: {serial_number: string}[]
    agreements: Agreement[]
}

export interface Account {
    properties: Property[]
}

export interface Property {
    moved_in_at: string | null
    moved_out_at: string | null
    electricity_meter_points: ElectricityMeterPoint[]
}

export interface ExportSelection {
    mpan?: string
    serial?: string
    importMpan?: string
}

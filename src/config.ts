import envVar from 'env-var'

export type Environment = Record<string, string | undefined>

export interface ElectricityConfig {
    account: string
    mpan?: string
    serial?: string
}

export interface GasConfig {
    mprn: string
    serial: string
    unitCostPence: number
    volumeCorrection: number
    calorificValue: number
    joulesConversion: number
}

export interface InfluxConfig {
    url: string
    token: string
    org: string
    bucket: string
}

export type OutputConfig = {dryRun: true} | {dryRun: false, influx: InfluxConfig}

export interface Config {
    apiKey: string
    pageSize: number
    loopTime: number
    timeoutSeconds: number
    output: OutputConfig
    electricity?: ElectricityConfig
    gas?: GasConfig
    export?: ElectricityConfig
    importMpan?: string
}

export function readConfig(environment: Environment): Config {
    const env = envVar.from(environment)
    const dryRun = env.get('DRY_RUN').default('false').asBoolStrict()
    const output: OutputConfig = dryRun ? {dryRun: true} : {
        dryRun: false,
        influx: {
            bucket: env.get('INFLUXDB_BUCKET').required().asString(),
            org: env.get('INFLUXDB_ORG').required().asString(),
            token: env.get('INFLUXDB_TOKEN').required().asString(),
            url: env.get('INFLUXDB_URL').required().asUrlString()
        }
    }
    const apiKey = env.get('OCTO_API_KEY').required().asString()
    const pageSize = env.get('PAGE_SIZE').default('48').asIntPositive()
    const loopTime = env.get('LOOP_TIME').default('600').asIntPositive()
    const timeoutSeconds = env.get('OCTO_TIMEOUT_SECONDS').default('60').asIntPositive()
    if (timeoutSeconds < 1 || timeoutSeconds > 2147483) {
        throw new Error('OCTO_TIMEOUT_SECONDS must be between 1 and 2147483')
    }
    if (pageSize < 1 || pageSize > 25000) {
        throw new Error('PAGE_SIZE must be between 1 and 25000')
    }

    function number(name: string): number | undefined {
        const raw = env.get(name).asString()
        if (raw === undefined) return undefined
        const value = Number(raw)
        if (!raw.trim() || !Number.isFinite(value)) {
            throw new Error(`${name} must be a finite number`)
        }
        return value
    }

    const mpan = env.get('OCTO_ELECTRIC_MPAN').asString()
    const serial = env.get('OCTO_ELECTRIC_SN').asString()
    const account = env.get('OCTO_ACCOUNT_NUMBER').asString()
    const importEnabled = env.get('OCTO_ELECTRIC_ENABLED').default(account || mpan || serial ? 'true' : 'false').asBoolStrict()
    let electricity: ElectricityConfig | undefined
    if (importEnabled) {
        if (!account) throw new Error('Import discovery and pricing require OCTO_ACCOUNT_NUMBER; set OCTO_ELECTRIC_ENABLED=false for export-only collection')
        electricity = {account, mpan, serial}
    }
    const legacySettings = ['OCTO_ELECTRIC_COST', 'OCTO_ELECTRIC_STANDING_CHARGE', 'OCTO_ELECTRIC_PRODUCT_CODE']
        .filter(name => env.get(name).asString() !== undefined)
    if (legacySettings.length) {
        console.warn(`Removed electricity pricing settings are ignored: ${legacySettings.join(', ')}. Rates now come exclusively from account agreements and the Octopus API.`)
    }

    const mprn = env.get('OCTO_GAS_MPRN').asString()
    const gasSerial = env.get('OCTO_GAS_SN').asString()
    const gasCost = number('OCTO_GAS_COST')
    const volumeCorrection = number('VOLUME_CORRECTION')
    const calorificValue = number('CALORIFIC_VALUE')
    const joulesConversion = number('JOULES_CONVERSION')
    if (joulesConversion === 0) {
        throw new Error('JOULES_CONVERSION must not be zero')
    }
    const gas = mprn && gasSerial && gasCost !== undefined && volumeCorrection !== undefined &&
        calorificValue !== undefined && joulesConversion !== undefined ? {
            mprn, serial: gasSerial, unitCostPence: gasCost,
            volumeCorrection, calorificValue, joulesConversion
        } : undefined

    let exportConfig: ElectricityConfig | undefined
    if (env.get('OCTO_EXPORT_ENABLED').default('false').asBoolStrict()) {
        const exportAccount = env.get('OCTO_EXPORT_ACCOUNT_NUMBER').asString() || account
        if (!exportAccount) {
            throw new Error('Export discovery and pricing require OCTO_ACCOUNT_NUMBER or OCTO_EXPORT_ACCOUNT_NUMBER')
        }
        exportConfig = {
            account: exportAccount,
            mpan: env.get('OCTO_EXPORT_MPAN').asString(),
            serial: env.get('OCTO_EXPORT_SN').asString()
        }
        if (exportConfig.mpan && exportConfig.mpan === mpan) {
            throw new Error('Export MPAN must differ from OCTO_ELECTRIC_MPAN')
        }
    }
    if (!electricity && !gas && !exportConfig) {
        throw new Error('No meters enabled. Configure electricity, gas, or OCTO_EXPORT_ENABLED=true')
    }
    return {apiKey, pageSize, loopTime, timeoutSeconds, output, electricity, gas, export: exportConfig, importMpan: mpan}
}

// Libraries
const {InfluxDB, Point} = require('@influxdata/influxdb-client')
const { toNanoDate } = require("influx")

const axios = require('axios');
const dotenv = require('dotenv');
const sleep = require('./sleep')

const env = require('env-var')

// Load dotenv
dotenv.config();

// Env Vars
const 
    INFLUXDB_BUCKET = env.get('INFLUXDB_BUCKET').required().asString(),
    INFLUXDB_ORG = env.get('INFLUXDB_ORG').required().asString(),
    INFLUXDB_TOKEN = env.get('INFLUXDB_TOKEN').required().asString(),
    INFLUXDB_URL = env.get('INFLUXDB_URL').required().asString(),
    LOOP_TIME = env.get('LOOP_TIME').required().asString(),
    OCTO_API_KEY = env.get('OCTO_API_KEY').required().asString(),
    PAGE_SIZE = env.get('PAGE_SIZE').required().asString(),

    OCTO_ELECTRIC_COST = env.get('OCTO_ELECTRIC_COST').asString(),
    OCTO_ELECTRIC_MPAN = env.get('OCTO_ELECTRIC_MPAN').asString(),
    OCTO_ELECTRIC_SN = env.get('OCTO_ELECTRIC_SN').asString(),
    OCTO_ELECTRIC_STANDING_CHARGE = env.get('OCTO_ELECTRIC_STANDING_CHARGE').asString(),
    OCTO_ELECTRIC_STANDING_CHARGE_URL = env.get('OCTO_ELECTRIC_STANDING_CHARGE_URL').asString(),
    OCTO_ELECTRIC_UNIT_RATE_URL = env.get('OCTO_ELECTRIC_UNIT_RATE_URL').asString(),

    CALORIFIC_VALUE = env.get('CALORIFIC_VALUE').asString(),
    JOULES_CONVERSION= env.get('JOULES_CONVERSION').asString(),
    OCTO_GAS_COST = env.get('OCTO_GAS_COST').asString(),
    OCTO_GAS_MPRN = env.get('OCTO_GAS_MPRN').asString(),
    OCTO_GAS_SN = env.get('OCTO_GAS_SN').asString(),
    VOLUME_CORRECTION = env.get('VOLUME_CORRECTION').asString()


const boot = async (callback) => {
    console.log("Starting Octopus Energy Consumption Metrics Container")
    console.log("Current Settings are:")
    console.log(`
        INFLUXDB_BUCKET = ${INFLUXDB_BUCKET}
        INFLUXDB_ORG = ${INFLUXDB_ORG}
        INFLUXDB_TOKEN = ${INFLUXDB_TOKEN}
        INFLUXDB_URL = ${INFLUXDB_URL}
        LOOP_TIME = ${LOOP_TIME}
        OCTO_API_KEY = ${OCTO_API_KEY}
        PAGE_SIZE = ${PAGE_SIZE}
    `)

    let processElectric = OCTO_ELECTRIC_MPAN && OCTO_ELECTRIC_SN && OCTO_ELECTRIC_COST && OCTO_ELECTRIC_STANDING_CHARGE
    if (processElectric) {
        console.log(`
        OCTO_ELECTRIC_COST = ${OCTO_ELECTRIC_COST}
        OCTO_ELECTRIC_MPAN = ${OCTO_ELECTRIC_MPAN}
        OCTO_ELECTRIC_SN = ${OCTO_ELECTRIC_SN}
        OCTO_ELECTRIC_STANDING_CHARGE = ${OCTO_ELECTRIC_STANDING_CHARGE}
        `)
    } else {
        console.log('Skipping processing electric, must set all variables: OCTO_ELECTRIC_MPAN, OCTO_ELECTRIC_SN, OCTO_ELECTRIC_COST')
    }

    let processGas = OCTO_GAS_SN && OCTO_GAS_MPRN && OCTO_GAS_COST && VOLUME_CORRECTION && CALORIFIC_VALUE && JOULES_CONVERSION
    if (processGas) {
        console.log(`
        CALORIFIC_VALUE = ${CALORIFIC_VALUE}
        JOULES_CONVERSION = ${JOULES_CONVERSION}
        OCTO_GAS_COST = ${OCTO_GAS_COST}
        OCTO_GAS_MPAN = ${OCTO_GAS_MPRN}
        OCTO_GAS_SN = ${OCTO_GAS_SN}
        VOLUME_CORRECTION = ${VOLUME_CORRECTION}
        `)
    } else {
        console.log('Skipping processing gas, must set all variables: OCTO_GAS_SN, OCTO_GAS_MPRN, OCTO_GAS_COST, VOLUME_CORRECTION, CALORIFIC_VALUE, JOULES_CONVERSION')
    }



    do {
        // Set up influx client
        const client = new InfluxDB({url: INFLUXDB_URL, token: INFLUXDB_TOKEN})
        const writeApi = client.getWriteApi(INFLUXDB_ORG, INFLUXDB_BUCKET)
        writeApi.useDefaultTags({app: 'octopus-energy-consumption-metrics'})
        console.log("Polling data from octopus API")

        // Retrieve data from octopus API
        let electricresponse = null
        let electricStandingChargeResponse = null
        let electricUnitPriceResponse = null
        let gasresponse = null

        try{
            let options = {auth: {
                username: OCTO_API_KEY
            }}
            if (processElectric) {
                electricresponse = await axios.get(`https://api.octopus.energy/v1/electricity-meter-points/${OCTO_ELECTRIC_MPAN}/meters/${OCTO_ELECTRIC_SN}/consumption?page_size=${PAGE_SIZE}`, options)
                if (OCTO_ELECTRIC_STANDING_CHARGE_URL) {
                    electricStandingChargeResponse = await axios.get(OCTO_ELECTRIC_STANDING_CHARGE_URL, options)
                }
                if (OCTO_ELECTRIC_UNIT_RATE_URL) {
                    electricUnitPriceResponse = await axios.get(OCTO_ELECTRIC_UNIT_RATE_URL, options)
                }
            }
            if (processGas) {
                gasresponse = await axios.get(`https://api.octopus.energy/v1/gas-meter-points/${OCTO_GAS_MPRN}/meters/${OCTO_GAS_SN}/consumption?page_size=${PAGE_SIZE}`, options)
            }
        } catch(e){
            console.log("Error retrieving data from octopus API")
            console.log(e)
        }

        // Now we loop over every result given to us from the API and feed that into influxdb

        if (processElectric) {
            const defaultUnitPrice = Number(OCTO_ELECTRIC_COST) / 100
            const defaultDailyStandingCharge = Number(OCTO_ELECTRIC_STANDING_CHARGE) / 100

            const electricStandingChargeResults = electricStandingChargeResponse ? await electricStandingChargeResponse.data.results : null
            const electricUnitPriceResults = electricUnitPriceResponse ? await electricUnitPriceResponse.data.results : null

            for await ( obj of electricresponse.data.results) {
                // Here we take the end interval, and convert it into nanoseconds for influxdb as nodejs works with ms, not ns
                const intervalStart = new Date(obj.interval_start)
                const intervalEnd = new Date(obj.interval_end)
                const nanoDate = toNanoDate(String(intervalEnd.valueOf()) + '000000')

                // find relevant standing charge value for period
                let standingChargeValue = null
                if (electricStandingChargeResults) {
                    standingChargeValue = findValueForDate(electricStandingChargeResults, intervalEnd)
                }
                const dailyStandingCharge = standingChargeValue ?? defaultDailyStandingCharge

                // find relevant unit price value for period
                let unitPriceValue = null
                if (electricUnitPriceResults) {
                    unitPriceValue = findValueForDate(electricUnitPriceResults, intervalEnd)
                }
                const unitPrice = unitPriceValue ?? defaultUnitPrice

                // now calculate the prorated amount for the interval from the daily standing charge
                const dateDiff = Math.abs(intervalEnd - intervalStart)
                const diffMinutes = Math.ceil(dateDiff / (1000 * 60))
                const minutesPerDay = 60 * 24
                const intervalStandingCharge = dailyStandingCharge * diffMinutes / minutesPerDay

                // calculate interval consumption and price
                const consumption = Number(obj.consumption)
                const usageprice = consumption * unitPrice

                // work out the consumption and hard set the datapoint's timestamp to the interval_end value from the API
                let electricpoint = new Point('electricity')
                    .floatField('consumption', consumption)
                    .floatField('daily_standing_charge', dailyStandingCharge)
                    .floatField('usageprice', usageprice)
                    .floatField('standing_change', intervalStandingCharge)
                    .floatField('unitprice', unitPrice)
                    .floatField('totalprice', usageprice + intervalStandingCharge)
                    .timestamp(nanoDate)

                // and then write the points:
                writeApi.writePoint(electricpoint)
            }
        }

        // Repeat the above but for gas
        if (processGas) {
            for await (obj of gasresponse.data.results) {
                const ts = new Date(obj.interval_end)
                const nanoDate = toNanoDate(String(ts.valueOf()) + '000000')

                let gaspoint = new Point('gas')
                    .floatField('consumption', Number(obj.consumption))
                    .timestamp(nanoDate)

                let kilowatts = (Number(obj.consumption) * Number(VOLUME_CORRECTION) * Number(CALORIFIC_VALUE)) / Number(JOULES_CONVERSION)

                let gaskwhpoint = new Point('gaskwh')
                .floatField('consumption_kwh', Number(kilowatts))
                .timestamp(nanoDate)

                let gascost = Number(kilowatts) * Number(OCTO_GAS_COST) / 100

                let gascostpoint = new Point('gas_cost')
                    .floatField('price', gascost)
                    .timestamp(nanoDate)

                writeApi.writePoint(gaspoint)
                writeApi.writePoint(gaskwhpoint)
                writeApi.writePoint(gascostpoint)
            }
        }

        await writeApi
            .close()
            .then(() => {
                console.log('Octopus API response submitted to InfluxDB successfully')
            })
            .catch(e => {
                console.error(e)
                console.log('Error submitting data to InfluxDB')
            })
        
        // Now sleep for the loop time
        console.log("Sleeping for: " + LOOP_TIME)
        sleep(Number(LOOP_TIME))
    } while (Number(LOOP_TIME)>0)
}

function findValueForDate(periods, searchDate) {
    let value = null
    for ( period of periods ) {
        if (period.payment_method == "DIRECT_DEBIT") {
            const periodStart = new Date(period.valid_from)
            const periodEnd = new Date(period.valid_to ?? "2999-12-31")
            if ( searchDate >= periodStart && searchDate < periodEnd ) {
                value = Number(period.value_inc_vat)
                break
            }
        }
    }
    return value
}

boot((error) => {
    if (error) {
        console.error(error)
        throw(error.message || error)
    }
  });

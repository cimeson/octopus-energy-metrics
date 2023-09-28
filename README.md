# octopus consumption metrics

A utility written in nodejs to pull energy consumption from the Octopus Energy API for tracking usage in grafana.

## How does it work?
The octopus API is a little strange in the way they provide data from smart meters.
It's really cool how they let you interface with them to be able to pull your own consumption data though!

Basically they poll your meter every day (or a smidge longer) for the 30 min interval statistics of your consumption
I was under the impression they polled it every 30 mins and the API would be "real time" but this is not the case - thanks to the point made in this blog post: 
https://www.guylipman.com/octopus/api_guide.html


This was quite frustrating as I had originally planned to do this as a prometheus based exporter, but when the data isn't near realtime, it makes it very tricky to handle, instead I opted to feed the data into InfluxDB. This is because you can specify the timestamp of the data point when you write it into Influx, meaning that I can poll the API for "new" data every so often, and back load it into influx.

More information can be found on my blog [here](https://ainsey11.com/monitoring-my-energy-consumption-with-octopus-energy-grafana-influxdb-and-node-js/)

## Docker

`docker build -t repo/octopus-energy-metrics:latest . `

## Docker-compose

rename the `.env.example` file to `.env` and edit the values in the `.env` file then run `docker-compose up -d` or `docker compose up -d`
 
## Environment Variables
To run the application, it takes certain variables to make it function. All of these variables are mandatory for the code to work.

| Environment Variable              | Group       | Optional/Required  | Description |
|-----------------------------------|-------------|--------------------|-------------|
| LOOP_TIME                         | App         | Required           | How often to poll the Octopus API in seconds |
| PAGE_SIZE                         | App         | Required           | How many data points to retrieve in one go, useful if you want to pull a large backload of data in for historical reasons, realistically this can be set to 48 (1 point every 30 mins in a 24 hour window) - maximum sizes are in the Octopus API docs |
| INFLUXDB_URL                      | InfluxDB    | Required           | the full url to your influddb server (https://influxdb.xxxx.xxxx) |
| INFLUXDB_TOKEN                    | InfluxDB    | Required           | A token for influx with write access to your bucket |
| INFLUXDB_ORG                      | InfluxDB    | Required           | the org in your influxdb server |
| INFLUXDB_BUCKET                   | InfluxDB    | Required           | the bucket name for your metrics to be stored in, this must exist first |
| OCTO_API_KEY                      | Octopus API | Required           | Your API Key from the dashboard |
| OCTO_ELECTRIC_MPAN                | Electricity | Required for Group | Your electric meter MPAN reference |
| OCTO_ELECTRIC_SN                  | Electricity | Required for Group | Your electric meter serial number |
| OCTO_ELECTRIC_COST                | Electricity | Required for Group | Your cost per KWH for electricity in pence |
| OCTO_ELECTRIC_PRODUCT_CODE        | Electricity | Optional           | Your electric product code, used to dynamically query variable unit cost and standing charge |
| OCTO_ELECTRIC_STANDING_CHARGE     | Electricity | Required for Group | Daily standing charge for electricity |
| OCTO_GAS_SN                       | Gas         | Required for Group | Your gas meter serial number |
| OCTO_GAS_MPRN                     | Gas         | Required for Group | Your gas meter MPRN reference |
| OCTO_GAS_COST                     | Gas         | Required for Group | Your cost per KWH for gas in pence |
| VOLUME_CORRECTION                 | Gas         | Required for Group | 1.02264 = standard volume correction rate for gas |
| CALORIFIC_VALUE                   | Gas         | Required for Group | 37.5 = standard calorific calue for gas |
| JOULES_CONVERSION                 | Gas         | Required for Group | 3.6 = standard conversion divider to convert to joules for gas |

* You can find the MPAN, MPRN and SN's of your devices in the Octopus dashboard.
* You can find your Octopus Product Code by navigating the Products API.

## Changes in forked development

This fork of the project extends the project purely for my own needs. Focusing on electricity only, since I don't have a gas supply.

* Restructure recording of data points so that reporting on costing is more easily achieved. I have not pushed the fork upstream as this change will likely break existing reporting.
* Standing charges are now included (these are prorated to each data point interval).
* Unit prices and standing charges can either be set as environment variables, or read from the Octopus Energy API.
* If the pricing API doesn't return a price for the period, then the environment variables are used as a default.
* Environment variables are now optional: leave out gas configuration to not read gas meter consumption from the API, and similarly for electricity (untested).

### Data Structure
Previously, seperate points were stored for the `electricity` and `electricity_cost` metrics.

Now, we have a single data point that includes the metrics for:
* `consumption` - number of units consumed in the period (30 minutes)
* `daily_standing_charge` - daily standing charge at the time of the datapoint
* `standing_charge` - prorated standing charge for the period (usually, daily charge divided by 48)
* `totalprice` = `usageprice` + `standing_charge`
* `unitprice` - this unit price at the time of the datapoint
* `usageprice` = `unitprice` x `consumption`

Gas data recording is currently unchanged, as I do not have a gas supply to test this.

### Standing Charges
```bash
# Your daily electric standing charge
OCTO_ELECTRIC_STANDING_CHARGE=0.61
```
### Dynamically using electricity prices from Octopus APIs (optional)
Configure the following the product code for your electricity plan to dynamically read current prices from the API. If the a pricing period for the data point being recorded can't be determined, or these product code is not specified, then it will fall back to the values specified by environment variables `OCTO_ELECTRIC_STANDING_CHARGE` and `OCTO_ELECTRIC_COST`.

```bash
# The product code for your electricity agreement
OCTO_ELECTRIC_PRODUCT_CODE={product_code}
```

I have not yet found a way of determining which Octopus product is active for an account, so this requires some digging to find. The starting point for working out the URL for the product you are using is https://api.octopus.energy/v1/products/.

### Independent Electricity / Gas Reading
Not all environment variables are required, when required variables are not all set for a group, then readings for that group will be disabled.

## Requirements


This can either be ran in docker or natively in a nodejs environment.
You will need:
 - An Octopus Energy Account
 - An Octopus API Key
 - An SMETS1 or SMETS2 compatible smart meter, sending readings into Octopus (they must be visible in the octopus dashboard)
 - NodeJS installed or docker
 - An InfluxDB server running with a token generated and a bucket created

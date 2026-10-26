import {InfluxDB, type Point} from '@influxdata/influxdb-client'
import type {OutputConfig} from './config.js'

export async function outputPoints(points: Point[], config: OutputConfig): Promise<void> {
    if (config.dryRun) {
        for (const point of points) console.log(point.toLineProtocol())
        console.log(`Dry run complete: ${points.length} points; no data sent to InfluxDB`)
        return
    }
    const client = new InfluxDB({url: config.influx.url, token: config.influx.token})
    const writer = client.getWriteApi(config.influx.org, config.influx.bucket)
    writer.writePoints(points)
    await writer.close()
    console.log('Octopus API response submitted to InfluxDB successfully')
}

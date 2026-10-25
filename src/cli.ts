import dotenv from 'dotenv'
import {boot} from './collector.js'

dotenv.config({quiet: true})
const args = process.argv.slice(2)
const unknown = args.filter(arg => arg !== '--dry-run' && arg !== '--backfill')
if (unknown.length) {
    console.error(`Unknown arguments: ${unknown.join(', ')}`)
    process.exitCode = 1
} else {
    boot({...process.env, ...(args.includes('--dry-run') ? {DRY_RUN: 'true'} : {})}, args.includes('--backfill'))
        .catch((error: unknown) => {
            console.error(`Collection failed: ${error instanceof Error ? error.message : String(error)}`)
            process.exitCode = 1
        })
}

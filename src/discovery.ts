import type {Account, ExportSelection, Meter, Property} from './types.js'

export function selectElectricityMeter(account: Account, {mpan, serial, importMpan}: ExportSelection, isExport: boolean, now = new Date()): Meter {
    const candidates: (Meter & {property: Property})[] = []
    for (const property of account.properties) {
        if ((property.moved_in_at && new Date(property.moved_in_at) > now) ||
            (property.moved_out_at && new Date(property.moved_out_at) <= now)) {
            continue
        }
        for (const point of property.electricity_meter_points) {
            if (point.is_export !== isExport || (mpan && point.mpan !== mpan)) {
                continue
            }
            for (const meter of point.meters) {
                if (!serial || meter.serial_number === serial) {
                    candidates.push({mpan: point.mpan, serial: meter.serial_number, property})
                }
            }
        }
    }

    // Prefer the import property's export supply unless an export MPAN was explicitly selected.
    let matches = candidates
    if (isExport && importMpan && !mpan) {
        const sameProperty = matches.filter(candidate =>
            candidate.property.electricity_meter_points.some(point => point.mpan === importMpan))
        if (sameProperty.length) matches = sameProperty
    }
    const unique = [...new Map(matches.map(meter => [
        `${meter.mpan}/${meter.serial}`, {mpan: meter.mpan, serial: meter.serial}
    ])).values()]
    const selected = unique[0]
    if (unique.length !== 1 || !selected) {
        const direction = isExport ? 'export' : 'import'
        throw new Error(unique.length === 0
            ? `No matching ${direction} meter found on the account. Check registration, account number, and meter filters`
            : `Multiple ${direction} meters found. Set ${isExport ? 'OCTO_EXPORT' : 'OCTO_ELECTRIC'}_MPAN and/or ${isExport ? 'OCTO_EXPORT' : 'OCTO_ELECTRIC'}_SN to select one explicitly`)
    }
    return selected
}

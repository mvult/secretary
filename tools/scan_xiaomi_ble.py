#!/usr/bin/env python3
import argparse
import asyncio
import datetime as dt

from bleak import BleakScanner


XIAOMI_FE95_UUID = "0000fe95-0000-1000-8000-00805f9b34fb"
SCALE_PRODUCT_ID = 0x3BD5


def hex_bytes(value: bytes) -> str:
    return value.hex().upper()


def classify_service_data(data: bytes) -> tuple[bool, str]:
    if len(data) < 4:
        return False, "short"

    product_id = data[2] | (data[3] << 8)
    if product_id != SCALE_PRODUCT_ID:
        return False, f"product=0x{product_id:04X}"

    if len(data) == 11 and data[0] == 0x10 and data[1] == 0x59:
        return True, "scale identity"

    return True, "scale candidate measurement"


async def main() -> None:
    parser = argparse.ArgumentParser(description="Log Xiaomi FE95 BLE advertisements.")
    parser.add_argument("--seconds", type=float, default=180.0)
    parser.add_argument("--all-fe95", action="store_true", help="Print every FE95 packet, not just the S400 product id.")
    args = parser.parse_args()

    seen = 0
    scale_seen = 0
    measurement_seen = 0

    def on_advertisement(device, advertisement_data):
        nonlocal seen, scale_seen, measurement_seen
        for uuid, data in advertisement_data.service_data.items():
            if uuid.lower() != XIAOMI_FE95_UUID:
                continue

            seen += 1
            is_scale, kind = classify_service_data(data)
            if not is_scale and not args.all_fe95:
                continue

            if is_scale:
                scale_seen += 1
            if is_scale and kind != "scale identity":
                measurement_seen += 1

            now = dt.datetime.now().strftime("%H:%M:%S.%f")[:-3]
            name = advertisement_data.local_name or device.name or ""
            manufacturer = " ".join(
                f"{company_id}: {hex_bytes(payload)}"
                for company_id, payload in advertisement_data.manufacturer_data.items()
            )
            print(
                f"{now} rssi={advertisement_data.rssi} address={device.address} "
                f"name={name!r} kind={kind} len={len(data)} service_data={hex_bytes(data)} "
                f"manufacturer={manufacturer}",
                flush=True,
            )

    print(
        f"Scanning for Xiaomi FE95 advertisements for {args.seconds:g}s. "
        "This does not pair/connect.",
        flush=True,
    )
    async with BleakScanner(on_advertisement) as scanner:
        await asyncio.sleep(args.seconds)

    print(
        f"Done. fe95={seen} scale={scale_seen} measurement_candidates={measurement_seen}",
        flush=True,
    )


if __name__ == "__main__":
    asyncio.run(main())

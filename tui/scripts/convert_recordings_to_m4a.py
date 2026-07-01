import argparse
import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.connection import close_database, init_database
from db.models import Recording
from services.audio_files import (
    AudioConversionError,
    canonical_audio_path,
    convert_audio_file_to_m4a,
    get_audio_duration_seconds,
)


async def convert_field(recording: Recording, field_name: str, *, dry_run: bool, delete_originals: bool) -> bool:
    current = getattr(recording, field_name)
    if not current:
        return False

    source = Path(current)
    if source.suffix.lower() != ".wav":
        return False
    if not source.exists():
        print(f"skip missing {field_name}: recording={recording.id} path={source}")
        return False

    target = canonical_audio_path(source)
    print(f"convert {field_name}: recording={recording.id} {source} -> {target}")
    if dry_run:
        return True

    try:
        if not target.exists():
            await asyncio.to_thread(convert_audio_file_to_m4a, source, target)
        duration = await asyncio.to_thread(get_audio_duration_seconds, target)
        if not duration or duration <= 0:
            raise AudioConversionError(f"converted file has invalid duration: {target}")
    except Exception as exc:
        logging.error("failed converting %s: %s", source, exc)
        return False

    setattr(recording, field_name, str(target))
    if field_name == "local_audio":
        recording.duration = duration
    await recording.save()

    if delete_originals:
        try:
            source.unlink()
        except OSError as exc:
            logging.warning("unable to delete original %s: %s", source, exc)

    return True


async def main() -> int:
    parser = argparse.ArgumentParser(description="Convert recording WAV files to AAC m4a and update DB paths.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned conversions without writing files or DB changes.")
    parser.add_argument("--delete-originals", action="store_true", help="Delete WAV files after successful conversion and DB update.")
    parser.add_argument("--local", action="store_true", help="Convert local_audio paths.")
    parser.add_argument("--nas", action="store_true", help="Convert nas_audio paths.")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of recordings to inspect.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    fields = []
    if args.local:
        fields.append("local_audio")
    if args.nas:
        fields.append("nas_audio")
    if not fields:
        fields = ["local_audio"]

    if not await init_database():
        return 1

    converted = 0
    inspected = 0
    try:
        query = Recording.all().order_by("id")
        if args.limit:
            query = query.limit(args.limit)
        recordings = await query
        for recording in recordings:
            inspected += 1
            for field_name in fields:
                if await convert_field(recording, field_name, dry_run=args.dry_run, delete_originals=args.delete_originals):
                    converted += 1
    finally:
        await close_database()

    action = "would convert" if args.dry_run else "converted"
    print(f"{action} {converted} file(s); inspected {inspected} recording(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

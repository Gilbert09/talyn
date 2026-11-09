"""Check native ELF alignment in the exact Android release bundle."""

import argparse
import hashlib
import struct
import zipfile
from pathlib import Path


def check_elf(data: bytes) -> None:
    if data[:4] != b"\x7fELF" or data[4] not in (1, 2):
        raise ValueError("Expected an ELF library.")
    endian = "<" if data[5] == 1 else ">"
    wide = data[4] == 2
    offset = struct.unpack_from(endian + ("Q" if wide else "I"), data, 32 if wide else 28)[0]
    size, count = struct.unpack_from(endian + "HH", data, 54 if wide else 42)
    loads = 0
    for index in range(count):
        start = offset + index * size
        kind = struct.unpack_from(endian + "I", data, start)[0]
        if kind == 1:
            loads += 1
            alignment = struct.unpack_from(endian + ("Q" if wide else "I"), data, start + (48 if wide else 28))[0]
            if alignment < 16384:
                raise ValueError("A native LOAD segment needs at least 16 KB alignment.")
    if not loads:
        raise ValueError("The ELF file has no LOAD segments.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    with zipfile.ZipFile(args.bundle) as archive:
        libraries = [name for name in archive.namelist() if name.endswith(".so")]
        if not libraries:
            raise ValueError("No native libraries found. Inspect the correct release bundle.")
        for name in libraries:
            check_elf(archive.read(name))
    print(f"ELF alignment passed for {len(libraries)} libraries.")
    print(f"SHA-256: {hashlib.file_digest(args.bundle.open('rb'), 'sha256').hexdigest()}")
    print("Also run bundletool, zipalign, signing inspection, and a 16 KB device smoke test.")


if __name__ == "__main__":
    main()

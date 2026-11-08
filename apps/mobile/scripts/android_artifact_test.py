"""Test the Android artifact gate with synthetic ELF headers."""

import struct
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

spec = spec_from_file_location("artifact", Path(__file__).with_name("check-android-artifact.py"))
artifact = module_from_spec(spec)
spec.loader.exec_module(artifact)


class AlignmentTests(unittest.TestCase):
    def test_native_load_alignment(self):
        for wide in (False, True):
            for endian, encoding in (("<", 1), (">", 2)):
                for alignment in (4096, 8192, 16384, 65536):
                    with self.subTest(wide=wide, endian=endian, alignment=alignment):
                        data = bytearray(256)
                        data[:6] = b"\x7fELF" + bytes([2 if wide else 1, encoding])
                        struct.pack_into(endian + ("Q" if wide else "I"), data, 32 if wide else 28, 64)
                        struct.pack_into(endian + "HH", data, 54 if wide else 42, 56 if wide else 32, 1)
                        struct.pack_into(endian + "I", data, 64, 1)
                        struct.pack_into(endian + ("Q" if wide else "I"), data, 64 + (48 if wide else 28), alignment)
                        if alignment < 16384:
                            with self.assertRaises(ValueError):
                                artifact.check_elf(data)
                        else:
                            artifact.check_elf(data)

    def test_missing_load_segments(self):
        with self.assertRaises(ValueError):
            artifact.check_elf(b"not an ELF file")


if __name__ == "__main__":
    unittest.main()

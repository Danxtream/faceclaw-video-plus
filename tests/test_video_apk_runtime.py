"""Offline structural regressions for the actual APK runtime gate."""
import importlib.util
import io
from pathlib import Path
import struct
import sys
import unittest
import zipfile

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    'runtime_check', Path(__file__).resolve().parents[1] / 'scripts/check-video-apk-runtime.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
EXCEPTIONS = 'com/arthenica/smartexception/java/Exceptions'
COMMON = 'com/arthenica/smartexception/AbstractExceptions'


def dex(defined, referenced=()):
    names = list(dict.fromkeys([*defined, *referenced]))
    string_offset = 112
    type_offset = string_offset + 4 * len(names)
    class_offset = type_offset + 4 * len(names)
    data = bytearray(class_offset + 32 * len(defined))
    data[:8] = b'dex\n035\0'
    for offset, value in [(36, 112), (40, 0x12345678),
                          (56, len(names)), (60, string_offset),
                          (64, len(names)), (68, type_offset),
                          (96, len(defined)), (100, class_offset)]:
        struct.pack_into('<I', data, offset, value)
    for index, name in enumerate(names):
        descriptor = ('L' + name + ';').encode()
        struct.pack_into('<I', data, string_offset + index * 4, len(data))
        struct.pack_into('<I', data, type_offset + index * 4, index)
        data.extend(bytes([len(descriptor)]) + descriptor + b'\0')
    for index, name in enumerate(defined):
        struct.pack_into('<I', data, class_offset + index * 32, names.index(name))
    struct.pack_into('<I', data, 32, len(data))
    return bytes(data)


def apk(*dex_files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for index, data in enumerate(dex_files):
            archive.writestr('classes' + (str(index + 1) if index else '') + '.dex', data)
    stream.seek(0)
    return stream


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.runtime = {check.CONFIG: {EXCEPTIONS, 'android/util/Log'},
                        EXCEPTIONS: {COMMON}, COMMON: {'java/lang/Object'}}

    def test_referenced_exception_is_not_a_definition(self):
        with self.assertRaisesRegex(ValueError, 'Missing APK class definitions:.*Exceptions'):
            check.check_apk(apk(dex([check.CONFIG, COMMON], [EXCEPTIONS])), self.runtime)

    def test_multidex_definitions_pass(self):
        report = check.check_apk(apk(dex([check.CONFIG]), dex([EXCEPTIONS, COMMON])), self.runtime)
        self.assertEqual(report['dex_files'], ['classes.dex', 'classes2.dex'])
        self.assertEqual(len(report['required_classes']), 3)

    def test_missing_transitive_class_fails(self):
        with self.assertRaisesRegex(ValueError, COMMON):
            check.check_apk(apk(dex([check.CONFIG, EXCEPTIONS])), self.runtime)

    def test_unsupplied_nonplatform_dependency_fails(self):
        self.runtime[COMMON].add('vendor/Missing')
        with self.assertRaisesRegex(ValueError, 'vendor/Missing'):
            check.check_apk(apk(dex(list(self.runtime))), self.runtime)

    def test_no_dex_fails(self):
        with self.assertRaisesRegex(ValueError, 'no DEX'):
            check.check_apk(apk(), self.runtime)

    def test_truncated_dex_fails(self):
        for length in (0, 8, 111, 120):
            with self.subTest(length=length), self.assertRaises(ValueError):
                check.dex_definitions(dex([check.CONFIG])[:length])

    def test_invalid_class_index_fails(self):
        data = bytearray(dex([check.CONFIG]))
        struct.pack_into('<I', data, struct.unpack_from('<I', data, 100)[0], 200)
        with self.assertRaisesRegex(ValueError, 'class type'):
            check.dex_definitions(data)

    def test_class_constants_and_method_descriptors(self):
        name = EXCEPTIONS.encode()
        method = ('(L' + COMMON + ';)V').encode()
        data = b'\xca\xfe\xba\xbe\0\0\0\x34\0\x04'
        data += b'\x01' + struct.pack('>H', len(name)) + name
        data += b'\x07\0\x01'
        data += b'\x01' + struct.pack('>H', len(method)) + method
        self.assertEqual(check.class_references(data), {EXCEPTIONS, COMMON})
        with self.assertRaises(ValueError):
            check.class_references(data[:-1])


if __name__ == '__main__':
    unittest.main()

"""Check actual APK class definitions against the pinned encoder runtime."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import zipfile


PLATFORM_PREFIXES = ('java/', 'javax/', 'android/', 'org/json/')
CONFIG = 'com/arthenica/ffmpegkit/FFmpegKitConfig'


def dex_definitions(data):
    """Read class_defs, never treating a referenced type as a definition."""
    def word(offset):
        if offset < 0 or offset + 4 > len(data):
            raise ValueError('Truncated DEX word')
        return struct.unpack_from('<I', data, offset)[0]

    if (len(data) < 112 or data[:4] != b'dex\n' or
            data[4:8] not in [b'035\0', b'037\0', b'038\0', b'039\0', b'040\0'] or
            word(32) != len(data) or word(36) != 112 or word(40) != 0x12345678):
        raise ValueError('Unsupported or truncated DEX header')

    def table(header, width):
        count, offset = word(header), word(header + 4)
        if count and (offset < 112 or offset + count * width > len(data)):
            raise ValueError('Truncated DEX table')
        return count, offset

    strings, string_offset = table(56, 4)
    types, type_offset = table(64, 4)
    classes, class_offset = table(96, 32)

    def descriptor(index):
        if index >= types:
            raise ValueError('Invalid DEX class type')
        string_index = word(type_offset + index * 4)
        if string_index >= strings:
            raise ValueError('Invalid DEX descriptor index')
        offset = word(string_offset + string_index * 4)
        # Skip the bounded ULEB128 UTF-16 length before the MUTF-8 string.
        for _ in range(5):
            if offset >= len(data):
                raise ValueError('Truncated DEX string length')
            byte = data[offset]
            offset += 1
            if byte < 128:
                break
        else:
            raise ValueError('Invalid DEX string length')
        end = data.find(b'\0', offset)
        if end < 0:
            raise ValueError('Unterminated DEX descriptor')
        value = data[offset:end].decode('utf-8', errors='surrogatepass')
        if not value.startswith('L') or not value.endswith(';'):
            raise ValueError('Invalid DEX class descriptor')
        return value[1:-1]

    return {descriptor(word(class_offset + index * 32)) for index in range(classes)}


def class_references(data):
    """Collect class constants and descriptor types from a JVM constant pool."""
    if len(data) < 10 or data[:4] != b'\xca\xfe\xba\xbe':
        raise ValueError('Invalid JVM class header')
    count = struct.unpack_from('>H', data, 8)[0]
    offset, index = 10, 1
    utf8, classes = {}, []
    widths = {3: 4, 4: 4, 5: 8, 6: 8, 8: 2, 9: 4, 10: 4, 11: 4,
              12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2}
    while index < count:
        if offset >= len(data):
            raise ValueError('Truncated JVM constant pool')
        tag = data[offset]
        offset += 1
        if tag == 1:
            if offset + 2 > len(data):
                raise ValueError('Truncated JVM UTF8 length')
            length = struct.unpack_from('>H', data, offset)[0]
            offset += 2
            if offset + length > len(data):
                raise ValueError('Truncated JVM UTF8 constant')
            # References are ASCII; unrelated Java MUTF-8 literals need not decode.
            utf8[index] = data[offset:offset + length].decode('utf-8', errors='replace')
            offset += length
        else:
            width = 2 if tag == 7 else widths.get(tag)
            if width is None or offset + width > len(data):
                raise ValueError('Invalid JVM constant')
            if tag == 7:
                classes.append(struct.unpack_from('>H', data, offset)[0])
            offset += width
        index += 2 if tag in (5, 6) else 1
    if any(entry not in utf8 for entry in classes):
        raise ValueError('Invalid JVM class name index')
    references = {utf8[entry] for entry in classes if not utf8[entry].startswith('[')}
    for value in utf8.values():
        references.update(re.findall(r'L([A-Za-z0-9_$/]+);', value))
    return references


def jar_classes(data):
    """Return each supplied runtime class and its bytecode references."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name[:-6]: class_references(archive.read(name))
                for name in archive.namelist() if name.endswith('.class')}


def check_apk(apk, runtime):
    """Require all pinned vendor classes and their non-platform dependencies."""
    if CONFIG not in runtime:
        raise ValueError('Encoder runtime lacks FFmpegKitConfig')
    required = set(runtime)
    required.update(ref for refs in runtime.values() for ref in refs
                    if not ref.startswith(PLATFORM_PREFIXES))
    with zipfile.ZipFile(apk) as archive:
        dex_names = sorted(name for name in archive.namelist()
                           if re.fullmatch(r'classes(?:[2-9]|[1-9][0-9]+)?\.dex', name))
        if not dex_names:
            raise ValueError('APK contains no DEX files')
        defined = set()
        for name in dex_names:
            defined.update(dex_definitions(archive.read(name)))
        missing = sorted(required - defined)
        if missing:
            raise ValueError('Missing APK class definitions: ' + ', '.join(missing))
    return dict(dex_files=dex_names, required_classes=sorted(required),
                config_references=sorted(runtime[CONFIG]), defined_count=len(defined))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--ffmpeg-aar', type=Path, required=True)
    parser.add_argument('--smart-java-jar', type=Path, required=True)
    parser.add_argument('--smart-common-jar', type=Path, required=True)
    args = parser.parse_args()
    pins = json.loads(Path(__file__).with_name('video-runtime-artifacts.json').read_text())
    runtime, artifacts = {}, []
    for key, path in [('ffmpeg', args.ffmpeg_aar), ('smart_java', args.smart_java_jar),
                      ('smart_common', args.smart_common_jar)]:
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != pins[key]['sha256']:
            raise ValueError('Runtime artifact does not match pin: ' + key)
        artifacts.append(dict(coordinate=pins[key]['coordinate'], sha256=digest, bytes=len(data)))
        if key == 'ffmpeg':
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                data = archive.read('classes.jar')
        runtime.update(jar_classes(data))
    report = check_apk(args.apk, runtime)
    license_path = Path(__file__).resolve().parents[1] / 'app/licenses/smart-exception-LICENSE.txt'
    license_asset = 'assets/app/about/ACKNOWLEDGEMENTS.md'
    with zipfile.ZipFile(args.apk) as archive:
        notice = archive.read(license_asset).replace(b'\r\n', b'\n')
        if license_path.read_bytes() not in notice:
            raise ValueError('APK lacks the complete retained smart-exception notice')
    report['license_asset'] = license_asset
    report['license_sha256'] = hashlib.sha256(license_path.read_bytes()).hexdigest()
    with args.apk.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    report.update(result='PASS', artifacts=artifacts, apk_sha256=digest)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()

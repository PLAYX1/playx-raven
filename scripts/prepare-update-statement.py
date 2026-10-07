#!/usr/bin/env python3
"""Local/offline release preparation. Emits public metadata only; never reads signing keys.
Sign the exact output separately with the release authority's minisign (prehashed mode).
"""
import argparse,hashlib,json,plistlib,tarfile,time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('package',type=Path);p.add_argument('--target',required=True,choices=['darwin-aarch64','darwin-x86_64'])
p.add_argument('--sequence',required=True,type=int);p.add_argument('--expires',required=True,type=int);p.add_argument('--output',required=True,type=Path)
a=p.parse_args()
if a.sequence<1 or a.expires<=int(time.time()):p.error('positive release sequence and future expiry required')
with tarfile.open(a.package,'r:gz') as archive:
    entries=[x for x in archive if len(Path(x.name).parts)==3 and x.name.endswith('.app/Contents/Info.plist')]
    if len(entries)!=1 or not entries[0].isfile() or entries[0].size>1024*1024:p.error('one top-level regular app Info.plist required')
    version=plistlib.load(archive.extractfile(entries[0])).get('CFBundleShortVersionString')
    if not isinstance(version,str):p.error('embedded version missing')
statement={'version':version,'sha256':hashlib.file_digest(a.package.open('rb'),'sha256').hexdigest(),'target':a.target,'expires':a.expires,'sequence':a.sequence}
a.output.write_text(json.dumps(statement,separators=(',',':')),encoding='utf8')
print('Public release statement prepared; package not executed, signed, uploaded or deployed.')

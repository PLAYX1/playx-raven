#!/usr/bin/env python3
"""Local/offline release preparation. Emits public metadata only; never reads signing keys.
Sign the exact output separately with the release authority's minisign (prehashed mode).

Targets and what is read from the package (the package is never executed):
  darwin-aarch64 / darwin-x86_64  .app.tar.gz  embedded Info.plist version (unchanged behavior)
  windows-x86_64                  NSIS setup .exe  embedded PE ProductVersion, must equal --version
  linux-x86_64                    .AppImage  ELF/AppImage markers + file name; internal version is NOT read
For windows/linux a human passes --version; it is cross-checked, never trusted alone.
"""
import argparse,hashlib,json,plistlib,re,struct,tarfile,time
from pathlib import Path

TARGETS=['darwin-aarch64','darwin-x86_64','windows-x86_64','linux-x86_64']
SEMVER=re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')

class PackageError(Exception):pass

def _read(f,offset,size,what):
    f.seek(offset)
    data=f.read(size)
    if len(data)!=size:raise PackageError(f'truncated file while reading {what}')
    return data

def pe_product_version(path):
    """Minimal PE resource walker (stdlib only): returns (ProductVersion string or None, fixed 4-part tuple or None)."""
    with open(path,'rb') as f:
        dos=_read(f,0,64,'DOS header')
        if dos[:2]!=b'MZ':raise PackageError('not a Windows executable (MZ header missing)')
        pe_off=struct.unpack_from('<I',dos,0x3C)[0]
        if _read(f,pe_off,4,'PE signature')!=b'PE\0\0':raise PackageError('not a PE file (PE signature missing)')
        coff=_read(f,pe_off+4,20,'COFF header')
        machine,nsec=struct.unpack_from('<HH',coff,0)
        opt_size=struct.unpack_from('<H',coff,16)[0]
        # NSIS setup stubs are 32-bit x86 (0x014c) even for x64 apps; accept that and x64 (0x8664), refuse ARM etc.
        if machine not in (0x014c,0x8664):raise PackageError(f'not an x86/x64 executable (machine 0x{machine:04x})')
        if nsec<1 or nsec>96 or opt_size<112:raise PackageError('invalid PE header')
        opt_off=pe_off+24
        opt=_read(f,opt_off,opt_size,'optional header')
        magic=struct.unpack_from('<H',opt,0)[0]
        dd_off={0x10b:96,0x20b:112}.get(magic)
        if dd_off is None:raise PackageError('unknown PE optional header')
        if opt_size<dd_off+8*3:raise PackageError('PE has no resource directory')
        res_rva,res_size=struct.unpack_from('<II',opt,dd_off+16)
        if res_rva==0 or res_size==0:raise PackageError('PE has no resources (no version information)')
        sections=[]
        table=_read(f,opt_off+opt_size,40*nsec,'section table')
        for i in range(nsec):
            vsize,vaddr,rawsize,rawptr=struct.unpack_from('<IIII',table,i*40+8)
            sections.append((vaddr,max(vsize,rawsize),rawsize,rawptr))
        def rva_to_off(rva):
            for vaddr,span,rawsize,rawptr in sections:
                if vaddr<=rva<vaddr+span:
                    if rva-vaddr>=rawsize:break
                    return rawptr+(rva-vaddr)
            raise PackageError('resource points outside the file sections')
        base=rva_to_off(res_rva)
        def entries(dir_off):
            hdr=_read(f,base+dir_off,16,'resource directory')
            n=struct.unpack_from('<H',hdr,12)[0]+struct.unpack_from('<H',hdr,14)[0]
            if n>256:raise PackageError('resource directory too large')
            raw=_read(f,base+dir_off+16,8*n,'resource entries')
            out=[]
            for i in range(n):
                name,off=struct.unpack_from('<II',raw,i*8)
                out.append((name,off&0x7fffffff,bool(off&0x80000000)))
            return out
        found=[e for e in entries(0) if e[0]==16 and e[2]]  # RT_VERSION
        if not found:raise PackageError('PE has no version resource')
        lvl2=entries(found[0][1])
        if not lvl2 or not lvl2[0][2]:raise PackageError('malformed version resource')
        lvl3=entries(lvl2[0][1])
        if not lvl3 or lvl3[0][2]:raise PackageError('malformed version resource')
        data_rva,data_size=struct.unpack('<II',_read(f,base+lvl3[0][1],8,'resource data entry'))
        if data_size<92 or data_size>65536:raise PackageError('unreasonable version resource size')
        blob=_read(f,rva_to_off(data_rva),data_size,'version resource')
    return _parse_version_blob(blob)

def _align4(n):return (n+3)&~3

def _node(blob,off,limit):
    if off+6>limit:raise PackageError('malformed version resource')
    length,vlen,vtype=struct.unpack_from('<HHH',blob,off)
    if length<6 or off+length>limit:raise PackageError('malformed version resource')
    end=off+length
    k=off+6
    while True:
        if k+2>end:raise PackageError('malformed version resource')
        if blob[k:k+2]==b'\0\0':break
        k+=2
    key=blob[off+6:k].decode('utf-16-le','replace')
    value_off=_align4(k+2)
    return key,vlen,vtype,value_off,end

def _parse_version_blob(blob):
    key,vlen,vtype,value_off,end=_node(blob,0,len(blob))
    if key!='VS_VERSION_INFO':raise PackageError('version resource is not VS_VERSION_INFO')
    fixed=None
    if vlen>=52 and value_off+52<=end and struct.unpack_from('<I',blob,value_off)[0]==0xFEEF04BD:
        ms,ls=struct.unpack_from('<II',blob,value_off+16)  # dwProductVersionMS/LS
        fixed=(ms>>16,ms&0xffff,ls>>16,ls&0xffff)
    child=_align4(value_off+vlen)
    product=None
    while child<end:
        ckey,cvlen,ctype,cvoff,cend=_node(blob,child,end)
        if ckey=='StringFileInfo':
            tab=_align4(cvoff)
            while tab<cend:
                tkey,tvlen,ttype,tvoff,tend=_node(blob,tab,cend)
                s=_align4(tvoff)
                while s<tend:
                    skey,svlen,stype,svoff,send=_node(blob,s,tend)
                    if skey=='ProductVersion' and product is None:
                        product=blob[svoff:svoff+svlen*2].decode('utf-16-le','replace').rstrip('\0').strip()
                    s=_align4(send)
                tab=_align4(tend)
        child=_align4(cend)
    return product,fixed

def _trim(version):
    parts=version.split('.')
    if len(parts)==4 and parts[3]=='0':parts=parts[:3]
    return '.'.join(parts)

def check_windows(package,version):
    if package.suffix.lower()!='.exe':raise PackageError('windows-x86_64 needs the NSIS setup .exe (not .msi)')
    product,fixed=pe_product_version(package)
    if product is None and fixed is None:raise PackageError('PE has no ProductVersion')
    seen=[]
    if product is not None:seen.append(_trim(product))
    if fixed is not None:seen.append(_trim('.'.join(map(str,fixed))))
    if any(v!=version for v in seen):
        raise PackageError(f'version mismatch: --version {version} but the installer says {", ".join(seen)}')
    return f'installer ProductVersion read and matches {version}'

def check_linux(package,version):
    if package.suffix!='.AppImage':raise PackageError('linux-x86_64 needs the .AppImage file')
    if not re.search(r'(?<![\d.])'+re.escape(version)+r'(?![\d.])',package.name):
        raise PackageError(f'file name "{package.name}" does not contain version {version}')
    with open(package,'rb') as f:
        head=_read(f,0,16,'ELF header')
    if head[:4]!=b'\x7fELF':raise PackageError('not an ELF file')
    if head[4]!=2 or head[5]!=1:raise PackageError('not a 64-bit little-endian ELF')
    with open(package,'rb') as f:
        machine=struct.unpack('<H',_read(f,18,2,'ELF machine'))[0]
    if machine!=62:raise PackageError(f'not an x86_64 ELF (machine {machine})')
    if head[8:10]!=b'AI' or head[10] not in (1,2):raise PackageError('AppImage marker (AI at byte 8) missing')
    return 'AppImage markers and file name match; the version inside the AppImage is NOT checked'

def main():
    p=argparse.ArgumentParser()
    p.add_argument('package',type=Path);p.add_argument('--target',required=True,choices=TARGETS)
    p.add_argument('--version',help='release version major.minor.patch; required for windows/linux, cross-checked for mac if given')
    p.add_argument('--sequence',required=True,type=int);p.add_argument('--expires',required=True,type=int);p.add_argument('--output',required=True,type=Path)
    a=p.parse_args()
    if a.sequence<1 or a.expires<=int(time.time()):p.error('positive release sequence and future expiry required')
    if a.version is not None and not SEMVER.match(a.version):p.error('--version must be canonical major.minor.patch')
    if not a.package.is_file():p.error('package file not found')
    note=''
    try:
        if a.target.startswith('darwin-'):
            with tarfile.open(a.package,'r:gz') as archive:
                entries=[x for x in archive if len(Path(x.name).parts)==3 and x.name.endswith('.app/Contents/Info.plist')]
                if len(entries)!=1 or not entries[0].isfile() or entries[0].size>1024*1024:p.error('one top-level regular app Info.plist required')
                version=plistlib.load(archive.extractfile(entries[0])).get('CFBundleShortVersionString')
                if not isinstance(version,str):p.error('embedded version missing')
            if a.version is not None and a.version!=version:p.error(f'--version {a.version} does not match embedded version {version}')
        else:
            if a.version is None:p.error('--version is required for windows-x86_64 and linux-x86_64')
            version=a.version
            note=(check_windows if a.target=='windows-x86_64' else check_linux)(a.package,version)
    except PackageError as e:
        p.error(str(e))
    statement={'version':version,'sha256':hashlib.file_digest(a.package.open('rb'),'sha256').hexdigest(),'target':a.target,'expires':a.expires,'sequence':a.sequence}
    a.output.write_text(json.dumps(statement,separators=(',',':')),encoding='utf8')
    if note:print('Check: '+note)
    print('Public release statement prepared; package not executed, signed, uploaded or deployed.')

if __name__=='__main__':main()

"""Check the installable release archive before extraction or promotion."""

import sys
import tarfile

with tarfile.open(sys.argv[1], "r|gz") as archive:
    binary = archive.next()
    if not (binary and binary.name == "opencode" and binary.isfile() and binary.mode & 0o100):
        sys.exit("Expected a regular, executable opencode at the archive root")
    if archive.extractfile(binary).read(4) != b"\x7fELF":
        sys.exit("Archived opencode is not an ELF binary")
    extra = archive.next()
    if extra:
        sys.exit(f"Expected only opencode in the archive, found extra member {extra.name!r}")

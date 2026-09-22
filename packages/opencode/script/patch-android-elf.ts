#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises"

const ET_DYN = 3
const EM_AARCH64 = 183
const PT_LOAD = 1
const PT_DYNAMIC = 2
const PF_W = 2
const SHT_NOBITS = 8
const SHF_ALLOC = 2
const DT_NULL = 0
const DT_RELA = 7
const DT_RELASZ = 8
const DT_RELAENT = 9
const R_AARCH64_RELATIVE = 1027

type LoadSegment = {
  offset: number
  vaddr: number
  filesz: number
  flags: number
}

type DynamicSegment = {
  offset: number
  filesz: number
}

type DynamicEntry = {
  tag: number
  value: number
  valueOffset: number
}

type Section = {
  name: string
  type: number
  flags: number
  addr: number
  offset: number
  size: number
}

type Elf = {
  view: DataView
  loadSegments: LoadSegment[]
  dynamicSegment: DynamicSegment
  sections: Section[]
}

type PointerSlot = {
  offset: number
  vaddr: number
}

export async function patchAndroidElf(file: string) {
  const data = new Uint8Array(await readFile(file))
  const elf = parseElf(data)
  const dynamic = parseDynamic(elf)
  const rela = requireDynamic(dynamic, DT_RELA, "DT_RELA")
  const relasz = requireDynamic(dynamic, DT_RELASZ, "DT_RELASZ")
  const relaent = dynamic.find((item) => item.tag === DT_RELAENT)?.value ?? 24

  if (relaent < 24) {
    throw new Error(`Unsupported DT_RELAENT ${relaent}`)
  }
  if (relasz.value % relaent !== 0) {
    throw new Error(`DT_RELASZ ${relasz.value} is not divisible by DT_RELAENT ${relaent}`)
  }

  const relaOffset = vaddrToOffset(elf.loadSegments, rela.value, relasz.value)
  const bun = requireBunSection(elf.sections)
  const slot = findBunPointerSlot(data, elf.loadSegments, bun, { offset: relaOffset, size: relasz.value })

  if (hasPayloadRelocation(elf.view, relaOffset, relasz.value, relaent, slot.vaddr, bun.addr)) {
    console.log(`Android ELF already patches Bun standalone payload pointer in ${file}`)
    return
  }

  const nextSize = relasz.value + relaent
  const nextRelaOffset = requireWritablePadding(data, elf, slot.offset, nextSize, { offset: relaOffset, size: relasz.value })
  const nextRelaVaddr = offsetToVaddr(elf.loadSegments, nextRelaOffset, nextSize)
  data.set(data.slice(relaOffset, relaOffset + relasz.value), nextRelaOffset)

  const nextEntry = nextRelaOffset + relasz.value
  writeU64(elf.view, nextEntry, slot.vaddr)
  writeU64(elf.view, nextEntry + 8, R_AARCH64_RELATIVE)
  writeI64(elf.view, nextEntry + 16, bun.addr)
  writeU64(elf.view, rela.valueOffset, nextRelaVaddr)
  writeU64(elf.view, relasz.valueOffset, nextSize)

  await writeFile(file, data)
  console.log(
    `Patched Android ELF ${file}: relocated Bun payload pointer ${hex(slot.vaddr)} -> ${hex(bun.addr)}`,
  )
}

function parseElf(data: Uint8Array): Elf {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (
    data.byteLength < 64 ||
    data[0] !== 0x7f ||
    data[1] !== 0x45 ||
    data[2] !== 0x4c ||
    data[3] !== 0x46
  ) {
    throw new Error("Expected an ELF file")
  }
  if (data[4] !== 2 || data[5] !== 1) {
    throw new Error("Expected a 64-bit little-endian ELF file")
  }
  if (readU16(view, 0x10) !== ET_DYN || readU16(view, 0x12) !== EM_AARCH64) {
    throw new Error("Expected an AArch64 PIE ELF file")
  }

  const programHeaderOffset = readU64(view, 0x20, "e_phoff")
  const sectionHeaderOffset = readU64(view, 0x28, "e_shoff")
  const programHeaderEntrySize = readU16(view, 0x36)
  const programHeaderCount = readU16(view, 0x38)
  const sectionHeaderEntrySize = readU16(view, 0x3a)
  const sectionHeaderCount = readU16(view, 0x3c)
  const sectionNameIndex = readU16(view, 0x3e)

  const loadSegments: LoadSegment[] = []
  let dynamicSegment: DynamicSegment | undefined

  for (let i = 0; i < programHeaderCount; i += 1) {
    const offset = programHeaderOffset + i * programHeaderEntrySize
    const type = readU32(view, offset)
    const flags = readU32(view, offset + 4)
    if (type === PT_LOAD) {
      loadSegments.push({
        flags,
        offset: readU64(view, offset + 8, "p_offset"),
        vaddr: readU64(view, offset + 16, "p_vaddr"),
        filesz: readU64(view, offset + 32, "p_filesz"),
      })
    }
    if (type === PT_DYNAMIC) {
      dynamicSegment = {
        offset: readU64(view, offset + 8, "p_offset"),
        filesz: readU64(view, offset + 32, "p_filesz"),
      }
    }
  }

  if (!dynamicSegment) {
    throw new Error("ELF file has no PT_DYNAMIC segment")
  }

  return {
    view,
    loadSegments,
    dynamicSegment,
    sections: parseSections(data, view, sectionHeaderOffset, sectionHeaderEntrySize, sectionHeaderCount, sectionNameIndex),
  }
}

function parseSections(
  data: Uint8Array,
  view: DataView,
  sectionHeaderOffset: number,
  sectionHeaderEntrySize: number,
  sectionHeaderCount: number,
  sectionNameIndex: number,
) {
  if (!sectionHeaderOffset || !sectionHeaderCount) {
    throw new Error("ELF file has no section headers; cannot find Bun payload section")
  }
  if (sectionNameIndex >= sectionHeaderCount) {
    throw new Error(`Invalid section string table index ${sectionNameIndex}`)
  }

  const stringHeader = sectionHeaderOffset + sectionNameIndex * sectionHeaderEntrySize
  const stringOffset = readU64(view, stringHeader + 24, "sh_offset")
  const sections: Section[] = []

  for (let i = 0; i < sectionHeaderCount; i += 1) {
    const offset = sectionHeaderOffset + i * sectionHeaderEntrySize
    sections.push({
      name: readString(data, stringOffset + readU32(view, offset)),
      type: readU32(view, offset + 4),
      flags: readU64(view, offset + 8, "sh_flags"),
      addr: readU64(view, offset + 16, "sh_addr"),
      offset: readU64(view, offset + 24, "sh_offset"),
      size: readU64(view, offset + 32, "sh_size"),
    })
  }

  return sections
}

function parseDynamic(elf: Elf) {
  const result: DynamicEntry[] = []
  for (let offset = elf.dynamicSegment.offset; offset < elf.dynamicSegment.offset + elf.dynamicSegment.filesz; offset += 16) {
    const tag = readU64(elf.view, offset, "d_tag")
    result.push({
      tag,
      value: readU64(elf.view, offset + 8, "d_val"),
      valueOffset: offset + 8,
    })
    if (tag === DT_NULL) break
  }
  return result
}

function requireDynamic(dynamic: DynamicEntry[], tag: number, name: string) {
  const entry = dynamic.find((item) => item.tag === tag)
  if (!entry) {
    throw new Error(`ELF dynamic section has no ${name}`)
  }
  return entry
}

function requireBunSection(sections: Section[]) {
  const matches = sections.filter((item) => item.name === ".bun" && item.type !== SHT_NOBITS && item.size > 0)
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one .bun section, found ${matches.length}`)
  }
  return matches[0]
}

function findBunPointerSlot(
  data: Uint8Array,
  loadSegments: LoadSegment[],
  bun: Section,
  rela: { offset: number; size: number },
): PointerSlot {
  const needle = u64Bytes(bun.addr)
  const excluded = [
    { offset: bun.offset, size: bun.size },
    rela,
  ]
  const candidates = loadSegments
    .filter((item) => (item.flags & PF_W) !== 0)
    .flatMap((segment) => {
      const result: PointerSlot[] = []
      const end = segment.offset + segment.filesz - needle.length
      for (let offset = align(segment.offset, 8); offset <= end; offset += 8) {
        if (excluded.some((item) => contains(item.offset, item.size, offset, needle.length))) continue
        if (!matches(data, offset, needle)) continue
        result.push({
          offset,
          vaddr: offsetToVaddr(loadSegments, offset, needle.length),
        })
      }
      return result
    })

  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one writable Bun payload pointer slot for ${hex(bun.addr)}, found ${candidates.length}`,
    )
  }
  return candidates[0]
}

function hasPayloadRelocation(
  view: DataView,
  relaOffset: number,
  relasz: number,
  relaent: number,
  slotVaddr: number,
  payloadVaddr: number,
) {
  for (let offset = relaOffset; offset < relaOffset + relasz; offset += relaent) {
    if (
      readU64(view, offset, "r_offset") === slotVaddr &&
      readU64(view, offset + 8, "r_info") % 0x100000000 === R_AARCH64_RELATIVE &&
      readI64(view, offset + 16, "r_addend") === payloadVaddr
    ) {
      return true
    }
  }
  return false
}

function requireWritablePadding(
  data: Uint8Array,
  elf: Elf,
  slotOffset: number,
  size: number,
  rela: { offset: number; size: number },
) {
  const occupied = [
    ...elf.sections
      .filter((item) => (item.flags & SHF_ALLOC) !== 0 && item.type !== SHT_NOBITS && item.size > 0)
      .map((item) => ({ offset: item.offset, size: item.size })),
    { offset: slotOffset, size: 8 },
    rela,
  ]

  const offset = findWritablePadding(data, elf.loadSegments, occupied, size, slotOffset + 8)
  if (offset !== undefined) return offset

  const fallback = findWritablePadding(data, elf.loadSegments, occupied, size, 0)
  if (fallback !== undefined) return fallback

  throw new Error(`Could not find ${size} bytes of writable zero padding for patched RELA table`)
}

function findWritablePadding(
  data: Uint8Array,
  loadSegments: LoadSegment[],
  occupied: Array<{ offset: number; size: number }>,
  size: number,
  minimumOffset: number,
) {
  for (const segment of loadSegments.filter((item) => (item.flags & PF_W) !== 0)) {
    const segmentStart = Math.max(segment.offset, minimumOffset)
    const segmentEnd = segment.offset + segment.filesz
    const ranges = occupied
      .map((item) => ({ start: item.offset, end: item.offset + item.size }))
      .filter((item) => item.start < segmentEnd && item.end > segmentStart)
      .sort((a, b) => a.start - b.start)
    let cursor = segmentStart

    for (const range of ranges) {
      const offset = align(cursor, 8)
      if (offset + size <= range.start && isZero(data, offset, size)) return offset
      cursor = Math.max(cursor, range.end)
    }

    const offset = align(cursor, 8)
    if (offset + size <= segmentEnd && isZero(data, offset, size)) return offset
  }
}

function vaddrToOffset(loadSegments: LoadSegment[], vaddr: number, size: number) {
  const segment = loadSegments.find((item) => vaddr >= item.vaddr && vaddr + size <= item.vaddr + item.filesz)
  if (!segment) {
    throw new Error(`Could not map virtual address ${hex(vaddr)} to a file offset`)
  }
  return segment.offset + vaddr - segment.vaddr
}

function offsetToVaddr(loadSegments: LoadSegment[], offset: number, size: number) {
  const segment = loadSegments.find((item) => offset >= item.offset && offset + size <= item.offset + item.filesz)
  if (!segment) {
    throw new Error(`Could not map file offset ${hex(offset)} to a virtual address`)
  }
  return segment.vaddr + offset - segment.offset
}

function readU16(view: DataView, offset: number) {
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number) {
  return view.getUint32(offset, true)
}

function readU64(view: DataView, offset: number, label: string) {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} ${value} is too large to handle safely`)
  }
  return Number(value)
}

function readI64(view: DataView, offset: number, label: string) {
  const value = view.getBigInt64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${label} ${value} is too large to handle safely`)
  }
  return Number(value)
}

function writeU64(view: DataView, offset: number, value: number) {
  view.setBigUint64(offset, BigInt(value), true)
}

function writeI64(view: DataView, offset: number, value: number) {
  view.setBigInt64(offset, BigInt(value), true)
}

function readString(data: Uint8Array, offset: number) {
  const end = data.indexOf(0, offset)
  return new TextDecoder().decode(data.slice(offset, end === -1 ? data.length : end))
}

function u64Bytes(value: number) {
  const data = new Uint8Array(8)
  writeU64(new DataView(data.buffer), 0, value)
  return data
}

function align(value: number, amount: number) {
  return Math.ceil(value / amount) * amount
}

function matches(data: Uint8Array, offset: number, needle: Uint8Array) {
  for (let i = 0; i < needle.length; i += 1) {
    if (data[offset + i] !== needle[i]) return false
  }
  return true
}

function contains(offset: number, size: number, targetOffset: number, targetSize: number) {
  return targetOffset < offset + size && targetOffset + targetSize > offset
}

function isZero(data: Uint8Array, offset: number, size: number) {
  for (let i = 0; i < size; i += 1) {
    if (data[offset + i] !== 0) return false
  }
  return true
}

function hex(value: number) {
  return `0x${value.toString(16)}`
}

if (import.meta.main) {
  const file = Bun.argv[2]
  if (!file) {
    throw new Error("Usage: patch-android-elf.ts <android-aarch64-elf>")
  }
  await patchAndroidElf(file)
}

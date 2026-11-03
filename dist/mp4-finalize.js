/**
 * Turns a fragmented MP4 (MediaRecorder with a timeslice) into a regular MP4
 * with one moov index, so Photos and other players show the right length and
 * can seek. Sample data is never re-encoded or read into memory: the result is
 * a Blob of the new header plus slices of the original.
 * finalizeMp4(blob) -> Blob (the original blob when it is not fragmented).
 * Safari writes the last sample of some fragments with a duration of -1 tick
 * and spaces video frames unevenly (2/23/47/68 ms); each fragment's span is
 * taken from the next fragment's tfdt, and video frames without composition
 * offsets are spread evenly over that span.
 */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'dinf', 'moof', 'traf']);
const NON_SYNC = 0x10000;
const BOGUS = 0x80000000;

async function bytes(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }
function type(view, at) { return String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7)); }
function u64(view, at) { return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4); }

async function topLevel(blob) {
  const boxes = [];
  for (let at = 0; at < blob.size;) {
    const head = await bytes(blob, at, Math.min(blob.size, at + 16));
    if (head.length < 8) break;
    const view = new DataView(head.buffer);
    let size = view.getUint32(0), header = 8;
    if (size === 1) { if (head.length < 16) break; size = u64(view, 8); header = 16; }
    else if (size === 0) size = blob.size - at;
    if (size < header) throw new Error('Broken MP4 box');
    boxes.push({ type: type(view, 0), start: at, size, header });
    at += size;
  }
  return boxes;
}

function children(data, start, end) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), list = [];
  for (let at = start; at + 8 <= end;) {
    let size = view.getUint32(at), header = 8;
    if (size === 1) { size = u64(view, at + 8); header = 16; } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw new Error('Broken MP4 box');
    const box = { type: type(view, at), start: at, end: at + size, header, data };
    if (CONTAINERS.has(box.type)) box.children = children(data, at + header, at + size);
    list.push(box);
    at += size;
  }
  return list;
}
const find = (list, name) => list.find(box => box.type === name);
const raw = box => box.data.subarray(box.start, box.end);
const body = box => new DataView(box.data.buffer, box.data.byteOffset + box.start + box.header, box.end - box.start - box.header);

function box(name, ...parts) {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  view.setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  let at = 8;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
function words(values, wide = []) {
  const out = new Uint8Array(values.reduce((sum, _, i) => sum + (wide.includes(i) ? 8 : 4), 0)), view = new DataView(out.buffer);
  let at = 0;
  values.forEach((value, i) => {
    if (wide.includes(i)) { view.setUint32(at, Math.floor(value / 2 ** 32)); view.setUint32(at + 4, value % 2 ** 32); at += 8; }
    else { view.setUint32(at, value >>> 0); at += 4; }
  });
  return out;
}
function table(name, version, entries, width, prefix = []) {
  const out = new Uint8Array(8 + prefix.length * 4 + entries.length * width * 4), view = new DataView(out.buffer);
  view.setUint32(0, version << 24);
  let at = 4;
  for (const value of prefix) { view.setUint32(at, value >>> 0); at += 4; }
  view.setUint32(at, entries.length); at += 4;
  for (const entry of entries) for (const value of entry) { view.setUint32(at, value >>> 0); at += 4; }
  return box(name, out);
}

function readFragments(moofs, trex) {
  const tracks = new Map();
  for (const { start, data } of moofs) {
    let previousEnd = start;
    for (const traf of children(data, 8, data.length).filter(item => item.type === 'traf')) {
      const tfhd = body(find(traf.children, 'tfhd'));
      const flags = tfhd.getUint32(0) & 0xffffff, id = tfhd.getUint32(4);
      const defaults = { ...trex.get(id) };
      let at = 8, base = flags & 0x20000 ? start : previousEnd;
      if (flags & 0x1) { base = u64(tfhd, at); at += 8; }
      if (flags & 0x2) at += 4;
      if (flags & 0x8) { defaults.duration = tfhd.getUint32(at); at += 4; }
      if (flags & 0x10) { defaults.size = tfhd.getUint32(at); at += 4; }
      if (flags & 0x20) defaults.flags = tfhd.getUint32(at);
      if (!tracks.has(id)) tracks.set(id, { sizes: [], durations: [], sync: [], offsets: [], chunks: [], fragments: [] });
      const track = tracks.get(id);
      const tfdtBox = find(traf.children, 'tfdt');
      let tfdt = null;
      if (tfdtBox) { const view = body(tfdtBox); tfdt = view.getUint8(0) ? u64(view, 4) : view.getUint32(4); }
      const fragment = { tfdt, first: track.sizes.length, count: 0 };
      let cursor = base;
      for (const trun of traf.children.filter(item => item.type === 'trun')) {
        const view = body(trun), runFlags = view.getUint32(0) & 0xffffff, count = view.getUint32(4);
        let p = 8, firstFlags = null;
        if (runFlags & 0x1) { cursor = base + view.getInt32(p); p += 4; }
        if (runFlags & 0x4) { firstFlags = view.getUint32(p); p += 4; }
        const chunk = { offset: cursor, count, bytes: 0 };
        if (count) track.chunks.push(chunk);
        for (let i = 0; i < count; i++) {
          const duration = runFlags & 0x100 ? view.getUint32((p += 4) - 4) : defaults.duration;
          const size = runFlags & 0x200 ? view.getUint32((p += 4) - 4) : defaults.size;
          let sampleFlags = runFlags & 0x400 ? view.getUint32((p += 4) - 4) : defaults.flags;
          if (i === 0 && firstFlags !== null) sampleFlags = firstFlags;
          const offset = runFlags & 0x800 ? view.getInt32((p += 4) - 4) : 0;
          track.sizes.push(size); track.durations.push(duration); track.sync.push(!(sampleFlags & NON_SYNC)); track.offsets.push(offset);
          chunk.bytes += size;
        }
        cursor += chunk.bytes;
        fragment.count += count;
      }
      previousEnd = cursor;
      if (fragment.count) track.fragments.push(fragment);
    }
  }
  return tracks;
}

function fixDurations(track, smooth) {
  const { durations, fragments } = track;
  const fallback = durations.find(value => value > 0 && value < BOGUS) || 1;
  let last = fallback;
  for (let i = 0; i < durations.length; i++) {
    if (durations[i] >= BOGUS || durations[i] === 0) durations[i] = last; else last = durations[i];
  }
  fragments.forEach((fragment, k) => {
    const next = fragments[k + 1], { first, count } = fragment;
    if ((next && next.tfdt === null) || fragment.tfdt === null) return;
    // The last fragment has no next tfdt; its own (fixed) total is the span.
    const span = next ? next.tfdt - fragment.tfdt : durations.slice(first, first + count).reduce((sum, value) => sum + value, 0);
    if (span < count) return;
    if (smooth) {
      for (let i = 0; i < count; i++) durations[first + i] = Math.floor((i + 1) * span / count) - Math.floor(i * span / count);
      return;
    }
    let sum = 0;
    for (let i = 0; i < count - 1; i++) sum += durations[first + i];
    if (span - sum >= 1) durations[first + count - 1] = span - sum;
  });
}

function runs(values) {
  const out = [];
  for (const value of values) { if (out.length && out.at(-1)[1] === value) out.at(-1)[0]++; else out.push([1, value]); }
  return out;
}

function sampleTable(stsd, track, chunkOffsets, wide) {
  const parts = [raw(stsd), table('stts', 0, runs(track.durations), 2)];
  if (track.offsets.some(Boolean)) parts.push(table('ctts', 1, runs(track.offsets), 2));
  if (track.sync.some(sync => !sync)) parts.push(table('stss', 0, track.sync.flatMap((sync, i) => sync ? [[i + 1]] : []), 1));
  const stsc = [];
  track.chunks.forEach((chunk, i) => { if (!stsc.length || stsc.at(-1)[1] !== chunk.count) stsc.push([i + 1, chunk.count, 1]); });
  parts.push(table('stsc', 0, stsc, 3));
  const same = track.sizes.every(size => size === track.sizes[0]);
  parts.push(same ? box('stsz', words([0, track.sizes[0], track.sizes.length])) : table('stsz', 0, track.sizes.map(size => [size]), 1, [0]));
  if (wide) {
    const out = new Uint8Array(8 + chunkOffsets.length * 8), view = new DataView(out.buffer);
    view.setUint32(4, chunkOffsets.length);
    chunkOffsets.forEach((offset, i) => { view.setUint32(8 + i * 8, Math.floor(offset / 2 ** 32)); view.setUint32(12 + i * 8, offset % 2 ** 32); });
    parts.push(box('co64', out));
  } else parts.push(table('stco', 0, chunkOffsets.map(offset => [offset]), 1));
  return box('stbl', ...parts);
}

function patchDuration(full, value, v0At, v1At) {
  const copy = full.slice(), view = new DataView(copy.buffer);
  if (view.getUint8(8)) { view.setUint32(v1At, Math.floor(value / 2 ** 32)); view.setUint32(v1At + 4, value % 2 ** 32); }
  else view.setUint32(v0At, Math.min(value, 0xffffffff));
  return copy;
}

function buildMoov(moov, tracks, movieScale, newOffsets, wide) {
  const parts = [], trackDurations = [];
  for (const trak of moov.children.filter(item => item.type === 'trak')) {
    const tkhd = find(trak.children, 'tkhd'), mdia = find(trak.children, 'mdia');
    const id = body(tkhd).getUint32(body(tkhd).getUint8(0) ? 20 : 12);
    const track = tracks.get(id);
    if (!track?.sizes.length) continue;
    const mdhd = find(mdia.children, 'mdhd'), minf = find(mdia.children, 'minf'), stbl = find(minf.children, 'stbl');
    const scale = body(mdhd).getUint32(body(mdhd).getUint8(0) ? 20 : 12);
    const mediaDuration = track.durations.reduce((sum, value) => sum + value, 0);
    const duration = Math.round(mediaDuration * movieScale / scale);
    const delay = Math.round((track.fragments[0]?.tfdt || 0) * movieScale / scale);
    trackDurations.push(duration + delay);
    const edts = delay ? box('edts', table('elst', 0, [[delay, 0xffffffff, 0x10000], [duration, 0, 0x10000]], 3)) : null;
    const stblNew = sampleTable(find(stbl.children, 'stsd'), track, newOffsets.get(id), wide);
    const minfNew = box('minf', ...minf.children.map(item => item.type === 'stbl' ? stblNew : raw(item)));
    const mdiaNew = box('mdia', ...mdia.children.map(item => item.type === 'mdhd' ? patchDuration(raw(item), mediaDuration, 24, 32) : item.type === 'minf' ? minfNew : raw(item)));
    const trakParts = [];
    for (const item of trak.children) {
      if (item.type === 'tkhd') { trakParts.push(patchDuration(raw(item), duration + delay, 28, 36)); if (edts) trakParts.push(edts); }
      else if (item.type === 'mdia') trakParts.push(mdiaNew);
      else if (item.type !== 'edts') trakParts.push(raw(item));
    }
    parts.push(box('trak', ...trakParts));
  }
  const total = Math.max(0, ...trackDurations);
  const top = moov.children.filter(item => item.type !== 'mvex' && item.type !== 'trak' && item.type !== 'mvhd').map(raw);
  return box('moov', patchDuration(raw(find(moov.children, 'mvhd')), total, 24, 32), ...parts, ...top);
}

export async function finalizeMp4(blob) {
  const boxes = await topLevel(blob);
  const moovBox = find(boxes, 'moov');
  const moofBoxes = boxes.filter(item => item.type === 'moof');
  if (!moovBox || !moofBoxes.length) return blob;
  const moovData = await bytes(blob, moovBox.start, moovBox.start + moovBox.size);
  const [moov] = children(moovData, 0, moovData.length);
  const trex = new Map();
  for (const item of find(moov.children, 'mvex')?.children || []) {
    if (item.type !== 'trex') continue;
    const view = body(item);
    trex.set(view.getUint32(4), { duration: view.getUint32(12), size: view.getUint32(16), flags: view.getUint32(20) });
  }
  const moofs = await Promise.all(moofBoxes.map(async item => ({ start: item.start, data: await bytes(blob, item.start, item.start + item.size) })));
  const tracks = readFragments(moofs, trex);
  for (const trak of moov.children.filter(item => item.type === 'trak')) {
    const tkhd = body(find(trak.children, 'tkhd')), id = tkhd.getUint32(tkhd.getUint8(0) ? 20 : 12);
    const hdlr = body(find(find(trak.children, 'mdia').children, 'hdlr'));
    const track = tracks.get(id);
    if (track) fixDurations(track, hdlr.getUint32(8) === 0x76696465 && !track.offsets.some(Boolean));
  }
  const chunks = [...tracks].flatMap(([id, track]) => track.chunks.map((chunk, index) => ({ ...chunk, id, index }))).sort((a, b) => a.offset - b.offset);
  const payload = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const wide = blob.size + 2 ** 20 > 0xffffffff;
  const ftyp = box('ftyp', words([0x69736f6d, 0x200, 0x69736f6d, 0x69736f32, 0x61766331, 0x6d703431]));
  const mdatHeader = payload + 8 > 0xffffffff ? words([1, 0x6d646174, payload + 16], [2]) : words([payload + 8, 0x6d646174]);
  const placeOffsets = moovSize => {
    const offsets = new Map([...tracks.keys()].map(id => [id, []]));
    let at = ftyp.length + moovSize + mdatHeader.length;
    for (const chunk of chunks) { offsets.get(chunk.id)[chunk.index] = at; at += chunk.bytes; }
    return offsets;
  };
  const mvhd = body(find(moov.children, 'mvhd')), movieScale = mvhd.getUint32(mvhd.getUint8(0) ? 20 : 12);
  const size = buildMoov(moov, tracks, movieScale, placeOffsets(0), wide).length;
  const header = buildMoov(moov, tracks, movieScale, placeOffsets(size), wide);
  const parts = [ftyp, header, mdatHeader];
  let run = null;
  for (const chunk of chunks) {
    if (run && run.end === chunk.offset) run.end += chunk.bytes;
    else { if (run) parts.push(blob.slice(run.start, run.end)); run = { start: chunk.offset, end: chunk.offset + chunk.bytes }; }
  }
  if (run) parts.push(blob.slice(run.start, run.end));
  return new Blob(parts, { type: blob.type || 'video/mp4' });
}

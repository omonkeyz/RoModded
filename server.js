'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
let fzstd = null;
try { fzstd = require('fzstd'); } catch { /* ZStd decompression — optional */ }
let zstdEnc = null;
try { zstdEnc = require('@mongodb-js/zstd'); } catch { /* ZStd compression — optional */ }

// ══════════════════════════════════════════════════════════════════════════════
//  RBXL BINARY PARSER  (custom — handles both LZ4 and ZStandard chunks)
//  Roblox binary format: 32-byte header, then chunks of:
//    [4-byte name][uint32 compSize][uint32 uncompSize][4 reserved][data]
//  String properties (data type 0x01) are length-prefixed: [uint32 len][bytes]
//  Newer RBXL files use ZStd (magic 0x28 0xB5 0x2F 0xFD); older ones use LZ4
// ══════════════════════════════════════════════════════════════════════════════

// RBXL binary magic: <roblox!\x89\xFF\r\n\x1a\n\x00\x00  (16 bytes)
const RBXL_MAGIC = Buffer.from([0x3C,0x72,0x6F,0x62,0x6C,0x6F,0x78,0x21,0x89,0xFF,0x0D,0x0A,0x1A,0x0A,0x00,0x00]);

function isRbxlBinary(buf) {
  if (buf.length < 16) return false;
  return buf.slice(0, 8).toString('ascii') === '<roblox!';
}

// Lenient LZ4 block decompressor — does NOT throw on trailing bytes
function lz4BlockDecompress(src, uncompSize) {
  const out = Buffer.alloc(uncompSize);
  let ip = 0, op = 0;
  while (ip < src.length && op < uncompSize) {
    const token = src[ip++];
    // Literal length
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b; do { if (ip >= src.length) break; b = src[ip++]; litLen += b; } while (b === 255);
    }
    // Copy literals (clamped)
    const lCopy = Math.min(litLen, src.length - ip, uncompSize - op);
    src.copy(out, op, ip, ip + lCopy);
    op += lCopy; ip += lCopy;
    if (lCopy < litLen || ip >= src.length || op >= uncompSize) break;
    // Match offset
    if (ip + 2 > src.length) break;
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0) break;
    // Match length
    let matchLen = (token & 0xF) + 4;
    if ((token & 0xF) === 15) {
      let b; do { if (ip >= src.length) break; b = src[ip++]; matchLen += b; } while (b === 255);
    }
    // Copy match (handles overlapping)
    let mp = op - offset;
    if (mp < 0) break;
    const mCopy = Math.min(matchLen, uncompSize - op);
    for (let i = 0; i < mCopy; i++) out[op++] = out[mp++];
  }
  return out; // may be shorter than uncompSize if stream ended early — that's OK
}

// ZStd magic: 0x28 0xB5 0x2F 0xFD (little-endian frame magic)
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

// Decompress one RBXL chunk; auto-detects ZStd vs LZ4; returns Buffer (decompressed)
function rbxlDecompressChunk(compData, compSize, uncompSize) {
  if (compSize === 0) return compData.slice(0, uncompSize);
  const src = compData.slice(0, compSize);
  // Detect ZStandard (newer Roblox files)
  if (src.length >= 4 && src.slice(0, 4).equals(ZSTD_MAGIC)) {
    if (fzstd) {
      try {
        const result = fzstd.decompress(src);
        return Buffer.from(result);
      } catch (e) {
        console.warn('[rbxl] zstd decompress failed:', e.message);
        return src; // fallback: raw bytes
      }
    }
    console.warn('[rbxl] ZStd chunk encountered but fzstd not loaded');
    return src;
  }
  // Legacy LZ4 block
  try {
    return lz4BlockDecompress(src, uncompSize);
  } catch {
    return src; // fallback: raw bytes
  }
}

// Extract all printable-ASCII text runs (>= minLen chars) from a Buffer
function extractTextRuns(buf, minLen = 10) {
  const parts = [];
  let start = -1, len = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const ok = (b >= 0x09 && b <= 0x0D) || (b >= 0x20 && b <= 0x7E);
    if (ok) { if (start < 0) start = i; len++; }
    else { if (len >= minLen) parts.push(buf.slice(start, start + len).toString('ascii')); start = -1; len = 0; }
  }
  if (len >= minLen) parts.push(buf.slice(start, start + len).toString('ascii'));
  return parts;
}

// Iterate RBXL chunks; cb(name, data) called for each (data = decompressed Buffer)
function rbxlForEachChunk(buf, cb) {
  if (!isRbxlBinary(buf)) throw new Error('Not a valid RBXL binary file');
  let pos = 32; // skip 32-byte header
  while (pos + 16 <= buf.length) {
    const name     = buf.slice(pos, pos + 4).toString('ascii').replace(/\0/g, '');
    const compSize = buf.readUInt32LE(pos + 4);
    const uncompSize = buf.readUInt32LE(pos + 8);
    pos += 16;
    if (name === 'END') { cb('END', Buffer.alloc(0)); break; }
    const dataSize = compSize || uncompSize;
    if (pos + dataSize > buf.length) break;
    const raw  = buf.slice(pos, pos + dataSize);
    const data = rbxlDecompressChunk(raw, compSize, uncompSize);
    pos += dataSize;
    cb(name, data);
  }
}

// Parse & extract all text from an RBXL binary buffer
function rbxlExtractText(buf) {
  const parts = [];
  rbxlForEachChunk(buf, (name, data) => {
    if (name === 'END' || name === 'PRNT' || name === 'META') return;
    extractTextRuns(data, 10).forEach(t => parts.push(t));
  });
  return parts.join('\n');
}

// Modify PROP chunk: replace IDs in all String (type 0x01) property values
// Returns new chunk Buffer with corrected string lengths
function rbxlModifyPropChunk(data, idMap) {
  if (data.length < 9) return data;
  const nameLen   = data.readUInt32LE(4);
  const hdrEnd    = 8 + nameLen;
  if (hdrEnd >= data.length) return data;
  const dataType  = data[hdrEnd];
  if (dataType !== 0x01) return data; // not String type — leave untouched

  const header = data.slice(0, hdrEnd + 1);
  const parts  = [header];
  let pos = hdrEnd + 1;
  while (pos + 4 <= data.length) {
    const strLen = data.readUInt32LE(pos);
    if (pos + 4 + strLen > data.length) { parts.push(data.slice(pos)); break; }
    let str = data.slice(pos + 4, pos + 4 + strLen).toString('latin1');
    for (const [oldId, newId] of Object.entries(idMap)) {
      str = str.replace(new RegExp(`(?<![0-9])${oldId}(?![0-9])`, 'g'), newId);
    }
    const newStrBuf = Buffer.from(str, 'latin1');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(newStrBuf.length, 0);
    parts.push(lenBuf, newStrBuf);
    pos += 4 + strLen;
  }
  return Buffer.concat(parts);
}

// Build a modified RBXL binary with IDs replaced; returns new Buffer (async for ZStd)
async function rbxlModify(buf, idMap) {
  if (!Object.keys(idMap).length) return buf;
  const header   = buf.slice(0, 32);
  const outParts = [header];
  const chunkQueue = [];

  rbxlForEachChunk(buf, (name, data) => {
    if (name === 'END') { chunkQueue.push({ name: 'END', data }); return; }
    if (name === 'PROP') data = rbxlModifyPropChunk(data, idMap);
    chunkQueue.push({ name, data });
  });

  for (const { name, data } of chunkQueue) {
    if (name === 'END') {
      const endHdr = Buffer.alloc(16); endHdr.write('END\0', 0, 'ascii');
      outParts.push(endHdr); break;
    }
    let compData = null;
    // Recompress with ZStd if available (keeps file size manageable)
    if (zstdEnc) {
      try { compData = await zstdEnc.compress(data, 3); } catch { compData = null; }
    }
    const chunkHdr = Buffer.alloc(16);
    chunkHdr.write(name.padEnd(4, '\0').slice(0, 4), 0, 'ascii');
    if (compData) {
      chunkHdr.writeUInt32LE(compData.length, 4); // compSize
      chunkHdr.writeUInt32LE(data.length,     8); // uncompSize
      outParts.push(chunkHdr, compData);
    } else {
      chunkHdr.writeUInt32LE(0,           4); // compSize = 0 (uncompressed)
      chunkHdr.writeUInt32LE(data.length, 8);
      outParts.push(chunkHdr, data);
    }
  }
  return Buffer.concat(outParts);
}

const PORT  = process.env.PORT || 5200;
const CHUNK = 100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function robloxReq({ hostname, path: urlPath, method = 'GET', cookie, csrf, apiKey, body: reqBody }) {
  return new Promise((resolve, reject) => {
    const data = reqBody ? JSON.stringify(reqBody) : null;
    const req  = https.request({
      hostname, path: urlPath, method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        ...(cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}),
        ...(csrf   ? { 'X-CSRF-TOKEN': csrf }               : {}),
        ...(apiKey ? { 'x-api-key': apiKey }                : {}),
        ...(data   ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  UNIVERSE ID RESOLVER
//  Roblox games APIs sometimes return place IDs where universe IDs are expected.
//  This function verifies a candidate ID and converts place→universe if needed.
// ══════════════════════════════════════════════════════════════════════════════

// Returns { universeId, rootPlaceId } — rootPlaceId may be null
// cookie is optional; used for authenticated fallback endpoints
async function resolveUniverseId(candidateId, cookie) {
  // Step 1: check if it's already a valid universe ID
  try {
    const r = await httpsGet(`https://games.roblox.com/v1/games?universeIds=${candidateId}`);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      if (d.data && d.data.length > 0) {
        const game  = d.data[0];
        const uid   = String(game.id);
        const rpid  = game.rootPlaceId ? String(game.rootPlaceId) : null;
        console.log(`[resolveUniverseId] ${candidateId} ✓ universe, rootPlaceId=${rpid}, name="${game.name}"`);
        return { universeId: uid, rootPlaceId: rpid };
      }
    }
  } catch { /* fall through */ }

  // Step 2: multiget-place-details (handles both bare array and {data:[]} format)
  try {
    const r = await httpsGet(
      `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${candidateId}`
    );
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const arr = Array.isArray(d) ? d : (d.data || []);
      if (arr.length > 0 && arr[0].universeId) {
        const uid = String(arr[0].universeId);
        console.log(`[resolveUniverseId] ${candidateId} place→universe ${uid} (multiget)`);
        return { universeId: uid, rootPlaceId: String(candidateId) };
      }
    }
    console.log(`[resolveUniverseId] multiget status=${r.status} body=${r.body.slice(0, 120)}`);
  } catch (e) { console.log(`[resolveUniverseId] multiget error: ${e.message}`); }

  // Step 3: develop.roblox.com/v1/places/{id} (authenticated — returns universe info)
  if (cookie) {
    try {
      const r = await robloxReq({
        hostname: 'develop.roblox.com',
        path: `/v1/places/${candidateId}`,
        cookie,
      });
      if (r.status === 200) {
        const d = JSON.parse(r.body);
        const uid = d.universeId ? String(d.universeId) : (d.universe?.id ? String(d.universe.id) : null);
        if (uid) {
          console.log(`[resolveUniverseId] ${candidateId} place→universe ${uid} (develop.v1)`);
          return { universeId: uid, rootPlaceId: String(candidateId) };
        }
      }
      console.log(`[resolveUniverseId] develop.v1/places status=${r.status} body=${r.body.slice(0, 120)}`);
    } catch (e) { console.log(`[resolveUniverseId] develop.v1/places error: ${e.message}`); }
  }

  // Step 4: apis.roblox.com universes/v1/places (newer API)
  try {
    const r = await httpsGet(`https://apis.roblox.com/universes/v1/places?placeIds=${candidateId}`);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const arr = Array.isArray(d) ? d : (d.data || []);
      if (arr.length > 0 && arr[0].universeId) {
        const uid = String(arr[0].universeId);
        console.log(`[resolveUniverseId] ${candidateId} place→universe ${uid} (apis.roblox)`);
        return { universeId: uid, rootPlaceId: String(candidateId) };
      }
    }
    console.log(`[resolveUniverseId] apis.universes status=${r.status} body=${r.body.slice(0, 120)}`);
  } catch (e) { console.log(`[resolveUniverseId] apis.universes error: ${e.message}`); }

  console.log(`[resolveUniverseId] could not resolve ${candidateId}, using as-is`);
  return { universeId: String(candidateId), rootPlaceId: null };
}

// ══════════════════════════════════════════════════════════════════════════════
//  THUMBNAIL HELPER  (batch, no auth needed)
// ══════════════════════════════════════════════════════════════════════════════

async function batchGameStats(universeIds) {
  if (!universeIds || !universeIds.length) return {};
  const map = {};
  for (let i = 0; i < universeIds.length; i += CHUNK) {
    const chunk = universeIds.slice(i, i + CHUNK);
    try {
      const { status, body } = await httpsGet(
        `https://games.roblox.com/v1/games?universeIds=${chunk.join(',')}`
      );
      if (status === 200) {
        (JSON.parse(body).data || []).forEach(g => {
          map[String(g.id)] = {
            visits:    g.visits        || 0,
            favorites: g.favoritedCount || 0,
            playing:   g.playing       || 0,
            isActive:  g.isActive !== false,
          };
        });
      }
    } catch { /* ignore */ }
    if (i + CHUNK < universeIds.length) await sleep(300);
  }
  return map;
}

async function batchGameVotes(universeIds) {
  if (!universeIds || !universeIds.length) return {};
  const map = {};
  for (let i = 0; i < universeIds.length; i += CHUNK) {
    const chunk = universeIds.slice(i, i + CHUNK);
    try {
      const { status, body } = await httpsGet(
        `https://games.roblox.com/v1/games/votes?universeIds=${chunk.join(',')}`
      );
      if (status === 200) {
        (JSON.parse(body).data || []).forEach(g => {
          const total = (g.upVotes || 0) + (g.downVotes || 0);
          map[String(g.id)] = {
            upVotes:   g.upVotes   || 0,
            downVotes: g.downVotes || 0,
            likeRatio: total > 0 ? Math.round((g.upVotes / total) * 100) : null,
          };
        });
      }
    } catch { /* ignore */ }
    if (i + CHUNK < universeIds.length) await sleep(300);
  }
  return map;
}

async function batchThumbs(endpoint, idParam, ids) {
  if (!ids || !ids.length) return {};
  const map = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const { status, body } = await httpsGet(
        `https://thumbnails.roblox.com/v1/${endpoint}?${idParam}=${chunk.join(',')}&size=150x150&format=Png`
      );
      if (status === 200) {
        (JSON.parse(body).data || []).forEach(item => {
          if (item.state === 'Completed') map[String(item.targetId)] = item.imageUrl;
        });
      }
    } catch { /* ignore */ }
    if (i + CHUNK < ids.length) await sleep(300);
  }
  return map;
}

// ══════════════════════════════════════════════════════════════════════════════
//  FILE SCAN VERIFICATION  (no auth — game pass & badge thumbnails + badge API)
// ══════════════════════════════════════════════════════════════════════════════

function formatKeyName(key) {
  return key.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

async function verify(ids, contextMap = {}) {
  const unique = [...new Set(ids.map(String))];
  console.log(`Verifying ${unique.length} IDs…`);

  const gpMap    = await batchThumbs('game-passes', 'gamePassIds', unique);
  const gpSet    = new Set(Object.keys(gpMap));
  const nonGP    = unique.filter(id => !gpSet.has(id));
  const badgeMap = await batchThumbs('badges', 'badgeIds', nonGP);
  const badgeSet = new Set(Object.keys(badgeMap));

  const badgeNames = {};
  for (const id of badgeSet) {
    try {
      const { status, body } = await httpsGet(`https://badges.roblox.com/v1/badges/${id}`);
      if (status === 200) { const d = JSON.parse(body); badgeNames[id] = d.name || d.displayName || null; }
    } catch { /* ignore */ }
    await sleep(80);
  }

  const results = [];
  for (const id of gpSet) {
    const ctx = contextMap[id] || {};
    results.push({ id, type: 'Game Pass', name: ctx.keyName ? formatKeyName(ctx.keyName) : null, verified: true });
  }
  for (const id of badgeSet) {
    results.push({ id, type: 'Badge', name: badgeNames[id] || null, verified: true });
  }
  for (const id of unique) {
    if (gpSet.has(id) || badgeSet.has(id)) continue;
    const ctx = contextMap[id] || {};
    if (ctx.keyName || ctx.apiCtx) {
      results.push({ id, type: 'Developer Product', name: ctx.keyName ? formatKeyName(ctx.keyName) : null, verified: false });
    }
  }

  console.log(`  → ${results.length} results`);
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════════

async function getAuthUser(cookie) {
  const r = await robloxReq({ hostname: 'users.roblox.com', path: '/v1/users/authenticated', cookie });
  if (r.status !== 200) throw new Error('Invalid or expired cookie — make sure you copied the full .ROBLOSECURITY value.');
  const user = JSON.parse(r.body);
  try {
    const tr    = await httpsGet(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=48x48&format=Png`);
    user.avatar = JSON.parse(tr.body).data?.[0]?.imageUrl || null;
  } catch { user.avatar = null; }
  return { id: user.id, name: user.name, displayName: user.displayName, avatar: user.avatar };
}

async function getCsrf(cookie) {
  const r = await robloxReq({ hostname: 'auth.roblox.com', path: '/v2/logout', method: 'POST', cookie });
  return r.headers['x-csrf-token'] || null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  GAMES  (groups + user's own)
// ══════════════════════════════════════════════════════════════════════════════

async function fetchGames(userId, cookie) {
  // ── User's own games ────────────────────────────────────────────────────────
  let myGames = [];
  try {
    // No accessFilter → Roblox returns all games the authenticated user owns
    const r = await robloxReq({
      hostname: 'games.roblox.com',
      path: `/v2/users/${userId}/games?limit=50&sortOrder=Asc`,
      cookie,
    });
    console.log(`[myGames] status=${r.status} body=${r.body.slice(0, 200)}`);
    if (r.status === 200) {
      myGames = JSON.parse(r.body).data || [];
      console.log(`[myGames] found ${myGames.length} games`);
    }
  } catch (e) {
    console.error(`[myGames] error: ${e.message}`);
  }

  // ── Group games ─────────────────────────────────────────────────────────────
  // Show all groups that have games visible to this user — no permission
  // pre-filter here. If the user can't manage a game's products the API will
  // say so when they click it, and we show a clear error at that point.
  const groupData = [];
  try {
    const gr = await robloxReq({
      hostname: 'groups.roblox.com',
      path: `/v1/users/${userId}/groups/roles`,
      cookie,
    });
    console.log(`[groups-roles] status=${gr.status}`);
    const groups = (JSON.parse(gr.body).data || []).filter(g => g.role.rank > 0);
    console.log(`[groups] ${groups.length} groups to check`);

    const gIds   = groups.map(g => String(g.group.id));
    const gIcons = await batchThumbs('groups/icons', 'groupIds', gIds);

    for (const g of groups) {
      try {
        await sleep(150);
        // accessFilter=2 = Public games (most reliable; works for all auth levels)
        const r = await robloxReq({
          hostname: 'games.roblox.com',
          path: `/v2/groups/${g.group.id}/games?accessFilter=2&limit=50&sortOrder=Asc`,
          cookie,
        });
        console.log(`[group-games] "${g.group.name}" rank=${g.role.rank} status=${r.status}`);
        if (r.status === 200) {
          const games = JSON.parse(r.body).data || [];
          if (games.length) {
            groupData.push({
              id:    g.group.id,
              name:  g.group.name,
              icon:  gIcons[String(g.group.id)] || null,
              role:  g.role.name,
              games: games.map(gm => ({ id: gm.id, name: gm.name, placeId: gm.rootPlace?.id })),
            });
          }
        }
      } catch (e) {
        console.log(`[group-games] "${g.group.name}" error: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[fetchGames] groups error: ${e.message}`);
  }

  // ── Attach game icons + stats ────────────────────────────────────────────────
  const allIds = [...new Set([
    ...myGames.map(g => String(g.id)),
    ...groupData.flatMap(g => g.games.map(gm => String(gm.id))),
  ])];
  const [gameIconMap, statsMap, votesMap] = await Promise.all([
    batchThumbs('games/icons', 'universeIds', allIds),
    batchGameStats(allIds),
    batchGameVotes(allIds),
  ]);

  const withGame = g => {
    const stats = statsMap[String(g.id)] || {};
    const votes = votesMap[String(g.id)] || {};
    return {
      ...g,
      icon:      gameIconMap[String(g.id)] || null,
      visits:    stats.visits    || 0,
      favorites: stats.favorites || 0,
      playing:   stats.playing   || 0,
      isActive:  stats.isActive !== false,
      upVotes:   votes.upVotes   || 0,
      downVotes: votes.downVotes || 0,
      likeRatio: votes.likeRatio ?? null,
    };
  };

  console.log(`[fetchGames] done — myGames=${myGames.length} groups=${groupData.length}`);
  return {
    myGames: myGames.map(g => withGame({ id: g.id, name: g.name, placeId: g.rootPlace?.id })),
    groups:  groupData.map(g => {
      const games = g.games.map(withGame);
      return {
        ...g,
        games,
        totalVisits:    games.reduce((a, gm) => a + gm.visits,    0),
        totalFavorites: games.reduce((a, gm) => a + gm.favorites, 0),
        totalPlaying:   games.reduce((a, gm) => a + gm.playing,   0),
      };
    }),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  GAME PRODUCTS  (dev products + game passes with icons & descriptions)
// ══════════════════════════════════════════════════════════════════════════════

async function fetchGameProducts(candidateId, cookie) {
  // Resolve the correct universe ID (the caller may have sent a place ID)
  const { universeId, rootPlaceId } = await resolveUniverseId(candidateId);

  let devProducts = [], gamePasses = [];
  const errors = [];

  // ── Developer Products ──────────────────────────────────────────────────────
  // Try develop.roblox.com v1 first (paginated); fall back to apis.roblox.com if 404
  let dpFetched = false;
  try {
    let cursor = null;
    do {
      if (cursor) await sleep(300);
      const r = await robloxReq({
        hostname: 'develop.roblox.com',
        path: `/v1/universes/${universeId}/developer-products?productName=&limit=500&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        cookie,
      });
      console.log(`[dev-products] develop.v1 status=${r.status} body=${r.body.slice(0, 200)}`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        devProducts = devProducts.concat(data.developerProducts || []);
        cursor = data.nextPageCursor || null;
        dpFetched = true;
      } else if (r.status === 401 || r.status === 403) {
        errors.push(`Developer Products: No creator access (HTTP ${r.status}).`);
        dpFetched = true; break; // don't retry
      } else {
        break; // 404 → fall through to new endpoint
      }
    } while (cursor);
  } catch (e) {
    errors.push(`Developer Products error: ${e.message}`);
    dpFetched = true;
  }

  if (!dpFetched) {
    // New endpoint used by Roblox Creator Hub for newer games
    try {
      let pageToken = null;
      // Pass 1: sortOrder=Asc (oldest first)
      do {
        if (pageToken) await sleep(300);
        const p = `/developer-products/v2/universes/${universeId}/developer-products/creator?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const r = await robloxReq({ hostname: 'apis.roblox.com', path: p, cookie });
        if (r.status === 200) {
          const data = JSON.parse(r.body);
          devProducts = devProducts.concat(data.developerProducts || []);
          pageToken = data.nextPageToken || null;
          console.log(`[dev-products] apis.v2 ASC status=${r.status} count=${(data.developerProducts||[]).length} total=${devProducts.length} nextPageToken=${pageToken}`);
        } else if (r.status === 401 || r.status === 403) {
          errors.push(`Developer Products: No creator access (HTTP ${r.status}).`);
          break;
        } else {
          errors.push(`Developer Products: HTTP ${r.status} — ${r.body.slice(0, 120)}`);
          break;
        }
      } while (pageToken);

      // Pass 2: sortOrder=Desc (newest first) — catches products beyond the first 100
      // when the API returns no nextPageToken despite more existing
      if (devProducts.length > 0 && !pageToken) {
        try {
          await sleep(300);
          const p2 = `/developer-products/v2/universes/${universeId}/developer-products/creator?pageSize=100&sortOrder=Desc`;
          const r2 = await robloxReq({ hostname: 'apis.roblox.com', path: p2, cookie });
          if (r2.status === 200) {
            const data2 = JSON.parse(r2.body);
            const seen = new Set(devProducts.map(dp => String(dp.productId || dp.id)));
            let added = 0;
            for (const dp of (data2.developerProducts || [])) {
              const id = String(dp.productId || dp.id);
              if (!seen.has(id)) { devProducts.push(dp); seen.add(id); added++; }
            }
            console.log(`[dev-products] apis.v2 DESC added=${added} total=${devProducts.length}`);
          }
        } catch (e) { /* ignore DESC failure */ }
      }
    } catch (e) {
      errors.push(`Developer Products error: ${e.message}`);
    }
  }

  // ── Game Passes (apis.roblox.com — works for all game ages/sizes) ───────────
  try {
    let pageToken = null;
    do {
      if (pageToken) await sleep(300);
      const p = `/game-passes/v1/universes/${universeId}/game-passes/creator?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await robloxReq({ hostname: 'apis.roblox.com', path: p, cookie });
      console.log(`[game-passes] universe=${universeId} status=${r.status} body=${r.body.slice(0, 200)}`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        gamePasses = gamePasses.concat(data.gamePasses || []);
        pageToken  = data.nextPageToken || null;
      } else if (r.status === 401 || r.status === 403) {
        errors.push(`Game Passes: No creator access (HTTP ${r.status}). Only the owner of this game can view its passes.`);
        break;
      } else {
        errors.push(`Game Passes: HTTP ${r.status} — ${r.body.slice(0, 120)}`);
        break;
      }
    } while (pageToken);
  } catch (e) {
    errors.push(`Game Passes error: ${e.message}`);
  }

  console.log(`[fetchGameProducts] universe=${universeId} gp=${gamePasses.length} dp=${devProducts.length} errors=${errors.length}`);

  // Icons in parallel
  const gpIds = gamePasses.map(gp => String(gp.id || gp.gamePassId || ''));
  const dpIds = devProducts.map(dp => String(dp.productId || dp.id || ''));

  const [gpIcons, dpIcons] = await Promise.all([
    batchThumbs('game-passes', 'gamePassIds', gpIds),
    batchThumbs('developer-products/icons', 'developerProductIds', dpIds).catch(() => ({})),
  ]);

  return {
    universeId: String(universeId),
    devProducts: devProducts.map(dp => ({
      id:          String(dp.productId || dp.id || ''),
      name:        dp.name        || dp.displayName || '',
      description: dp.description || dp.Description || '',
      price:       dp.priceInformation?.defaultPriceInRobux ?? dp.priceInRobux ?? dp.price ?? null,
      icon:        dpIcons[String(dp.productId || dp.id || '')] || null,
      type:        'Developer Product',
    })),
    gamePasses: gamePasses.map(gp => ({
      id:          String(gp.id || gp.gamePassId || ''),
      name:        gp.displayName || gp.name || '',
      description: gp.description || '',
      price:       gp.priceInformation?.defaultPriceInRobux ?? gp.price ?? gp.priceInRobux ?? null,
      icon:        gpIcons[String(gp.id || gp.gamePassId || '')] || null,
      type:        'Game Pass',
    })),
    _errors: errors,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  UPDATE PRICES
// ══════════════════════════════════════════════════════════════════════════════

async function updatePrices(universeId, updates, cookie) {
  const csrf = await getCsrf(cookie);
  if (!csrf) throw new Error('Could not get CSRF token — try reconnecting.');

  // Pre-fetch product names for any dev product updates that have no name provided
  const nameCache = {};
  const needsLookup = updates.some(u => u.type === 'Developer Product' && !u.name);
  if (needsLookup) {
    try {
      let pageToken = null;
      do {
        if (pageToken) await sleep(300);
        const p = `/developer-products/v2/universes/${universeId}/developer-products/creator?pageSize=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const r = await robloxReq({ hostname: 'apis.roblox.com', path: p, cookie });
        if (r.status === 200) {
          const data = JSON.parse(r.body);
          (data.developerProducts || []).forEach(dp => {
            const id = String(dp.productId || dp.id || '');
            nameCache[id] = { name: dp.name || '', description: dp.description || '' };
          });
          pageToken = data.nextPageToken || null;
        } else break;
      } while (pageToken);
    } catch (e) { /* proceed without cache */ }
  }

  const success = [], failed = [];

  for (const u of updates) {
    await sleep(300);
    try {
      const newPrice = Math.max(0, Math.round(Number(u.newPrice)));
      let r;

      if (u.type === 'Developer Product') {
        const name = u.name || nameCache[u.id]?.name || '';
        const desc = u.description || nameCache[u.id]?.description || '';
        if (!name) {
          failed.push({ id: u.id, error: 'Developer Product requires a name — product not found in game' });
          continue;
        }
        r = await robloxReq({
          hostname: 'develop.roblox.com',
          path:     `/v1/universes/${universeId}/developer-products/${u.id}`,
          method:   'POST',
          cookie, csrf,
          body: { priceInRobux: newPrice, name, description: desc },
        });
        console.log(`[updatePrices] dp id=${u.id} universe=${universeId} status=${r.status} body=${r.body.slice(0, 200)}`);

        // Fallback: apis.roblox.com v2 PATCH with multipart/form-data
        // (develop.roblox.com returns 404 for group games; v2 requires multipart not JSON)
        if (r.status >= 300) {
          const bd = `----FB${Date.now()}`;
          const fields = { name, description: desc, price: String(newPrice), isForSale: newPrice > 0 ? 'true' : 'false' };
          const mpBody = Object.entries(fields).map(([k, v]) =>
            `--${bd}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`
          ).join('\r\n') + `\r\n--${bd}--\r\n`;
          const r2 = await new Promise((resolve, reject) => {
            const req2 = https.request({
              hostname: 'apis.roblox.com',
              path: `/developer-products/v2/universes/${universeId}/developer-products/${u.id}`,
              method: 'PATCH',
              headers: {
                'Accept': 'application/json',
                'Content-Type': `multipart/form-data; boundary=${bd}`,
                'Content-Length': Buffer.byteLength(mpBody),
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'x-csrf-token': csrf,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              },
            }, res2 => {
              let b = ''; res2.on('data', c => b += c);
              res2.on('end', () => resolve({ status: res2.statusCode, body: b }));
            });
            req2.setTimeout(12000, () => req2.destroy(new Error('timeout')));
            req2.on('error', reject);
            req2.write(mpBody); req2.end();
          });
          console.log(`[updatePrices] dp v2 PATCH id=${u.id} status=${r2.status} body=${r2.body.slice(0, 200)}`);
          if (r2.status < 300) r = r2;
        }
      } else {
        // Game Pass
        const gpBody = { priceInRobux: newPrice, isForSale: newPrice > 0 };
        if (u.name)                           gpBody.name        = u.name;
        if (u.description !== undefined)      gpBody.description = u.description;
        r = await robloxReq({
          hostname: 'itemconfiguration.roblox.com',
          path:     `/v1/game-passes/${u.id}`,
          method:   'PATCH',
          cookie, csrf,
          body: gpBody,
        });
        console.log(`[updatePrices] gp id=${u.id} status=${r.status} body=${r.body.slice(0, 200)}`);
      }

      if (r && r.status < 300) {
        success.push(u.id);
      } else {
        const errBody = r?.body ? r.body.slice(0, 300) : 'no response';
        console.log(`[updatePrices] FAILED id=${u.id} status=${r?.status} body=${errBody}`);
        failed.push({ id: u.id, error: `HTTP ${r?.status} — ${errBody}` });
      }
    } catch (e) {
      failed.push({ id: u.id, error: e.message });
    }
  }

  return { success, failed };
}

// ══════════════════════════════════════════════════════════════════════════════
//  STATIC FILE SERVER
// ══════════════════════════════════════════════════════════════════════════════

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css',
  '.json': 'application/json',
};

function serveStatic(res, reqPath) {
  const filePath = reqPath === '/'
    ? path.join(__dirname, 'index.html')
    : path.join(__dirname, reqPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════════════════════

const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const method   = req.method;

  try {
    if (method === 'POST' && pathname === '/api/verify') {
      const { ids, contextMap } = await parseBody(req);
      if (!Array.isArray(ids) || !ids.length) { send(res, 400, { error: 'ids required' }); return; }
      send(res, 200, await verify(ids, contextMap || {}));
      return;
    }

    if (method === 'POST' && pathname === '/api/auth') {
      const { cookie } = await parseBody(req);
      if (!cookie) { send(res, 400, { error: 'cookie required' }); return; }
      send(res, 200, await getAuthUser(cookie.trim()));
      return;
    }

    if (method === 'POST' && pathname === '/api/games') {
      const { cookie, userId } = await parseBody(req);
      if (!cookie || !userId) { send(res, 400, { error: 'cookie and userId required' }); return; }
      send(res, 200, await fetchGames(userId, cookie.trim()));
      return;
    }

    if (method === 'POST' && pathname === '/api/game-products') {
      const { cookie, universeId, placeId, sampleIds } = await parseBody(req);
      if (!cookie || (!universeId && !placeId && !sampleIds?.length)) {
        send(res, 400, { error: 'cookie and universeId, placeId, or sampleIds required' }); return;
      }

      let uid = universeId;
      let uidResolved = !!universeId;

      // Try resolving from place ID
      if (!uidResolved && placeId) {
        const r = await resolveUniverseId(placeId, cookie.trim());
        uidResolved = r.universeId !== String(placeId); // false if fell back to as-is
        uid = r.universeId;
      }

      // Fallback: infer universe from developer product details endpoint
      if (!uidResolved && sampleIds?.length) {
        for (const productId of sampleIds.slice(0, 10)) {
          try {
            const r = await robloxReq({
              hostname: 'apis.roblox.com',
              path: `/developer-products/v1/developer-products/${productId}/details`,
              cookie: cookie.trim(),
            });
            console.log(`[game-products] product ${productId} details status=${r.status} body=${r.body.slice(0, 120)}`);
            if (r.status === 200) {
              const d = JSON.parse(r.body);
              const found = d.universeId || d.UniverseId;
              if (found) {
                uid = String(found);
                uidResolved = true;
                console.log(`[game-products] universe ${uid} resolved from product ${productId}`);
                break;
              }
            }
          } catch (e) {
            console.log(`[game-products] product lookup error: ${e.message}`);
          }
        }
      }

      if (!uid) { send(res, 400, { error: 'Could not resolve game universe ID' }); return; }
      send(res, 200, await fetchGameProducts(uid, cookie.trim()));
      return;
    }

    if (method === 'POST' && pathname === '/api/lookup-products') {
      const { cookie, ids } = await parseBody(req);
      if (!cookie || !Array.isArray(ids) || !ids.length) {
        send(res, 400, { error: 'cookie and ids[] required' }); return;
      }

      const cleanIds = [...new Set(ids.map(x => String(x).replace(/\D/g, '')).filter(Boolean))];
      const CONCURRENCY = 5;
      const products = [];

      // Check each ID against both developer-products AND game-passes APIs
      for (let i = 0; i < cleanIds.length; i += CONCURRENCY) {
        const batch = cleanIds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async id => {
          // Try developer product first
          try {
            const r = await robloxReq({
              hostname: 'apis.roblox.com',
              path: `/developer-products/v1/developer-products/${id}/details`,
              cookie: cookie.trim(),
            });
            if (r.status === 200) {
              const d = JSON.parse(r.body);
              return {
                id:          String(d.ProductId || id),
                name:        d.Name || d.DisplayName || '',
                description: d.Description || '',
                price:       typeof d.PriceInRobux === 'number' ? d.PriceInRobux : null,
                universeId:  d.UniverseId ? String(d.UniverseId) : null,
                type:        'Developer Product',
              };
            }
          } catch (e) {
            console.log(`[lookup-products] devprod id=${id} error: ${e.message}`);
          }
          // Try game pass via itemconfiguration (the correct individual-lookup endpoint)
          try {
            const r = await robloxReq({
              hostname: 'itemconfiguration.roblox.com',
              path: `/v1/game-passes/${id}`,
              cookie: cookie.trim(),
            });
            if (r.status === 200) {
              const d = JSON.parse(r.body);
              return {
                id:          String(d.id || id),
                name:        d.name || d.displayName || '',
                description: d.description || '',
                price:       typeof d.price === 'number' ? d.price
                           : typeof d.priceInRobux === 'number' ? d.priceInRobux : null,
                universeId:  d.universeId ? String(d.universeId) : null,
                type:        'Game Pass',
              };
            }
          } catch (e) {
            console.log(`[lookup-products] gamepass id=${id} error: ${e.message}`);
          }
          return null;
        }));
        results.forEach(p => { if (p) products.push(p); });
        if (i + CONCURRENCY < cleanIds.length) await sleep(200);
      }

      console.log(`[lookup-products] checked ${cleanIds.length} IDs, found ${products.length} products`);

      // Fetch universe name for the detected game
      let universeName = null;
      const firstUid = products.find(p => p.universeId)?.universeId;
      if (firstUid) {
        try {
          const r = await httpsGet(`https://games.roblox.com/v1/games?universeIds=${firstUid}`);
          if (r.status === 200) {
            const d = JSON.parse(r.body);
            universeName = d.data?.[0]?.name || null;
          }
        } catch { /* ignore */ }
      }

      send(res, 200, { products, universeId: firstUid || null, universeName });
      return;
    }

    if (method === 'POST' && pathname === '/api/create-products') {
      const { cookie, universeId, products } = await parseBody(req);
      if (!cookie || !universeId || !Array.isArray(products) || !products.length) {
        send(res, 400, { error: 'cookie, universeId, products[] required' }); return;
      }
      const csrf = await getCsrf(cookie.trim());
      if (!csrf) { send(res, 401, { error: 'Could not get CSRF token' }); return; }

      const success = [], failed = [];
      for (const p of products) {
        await sleep(300);
        try {
          const name = (p.name || '').trim();
          if (!name) { failed.push({ id: p.id, error: 'Name is required' }); continue; }
          const price = Math.max(0, Math.round(Number(p.price) || 0));

          // Helper: make multipart body
          const makeMP = (fields) => {
            const bd = `----FB${Date.now()}${Math.random().toString(36).slice(2)}`;
            const body = Object.entries(fields).map(([k, v]) =>
              `--${bd}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`
            ).join('\r\n') + `\r\n--${bd}--\r\n`;
            return { bd, body };
          };

          const multipartReq = (hostname, urlPath, method, fields) => {
            const { bd, body } = makeMP(fields);
            return new Promise((resolve, reject) => {
              const req2 = https.request({
                hostname, path: urlPath, method,
                headers: {
                  'Accept': 'application/json',
                  'Content-Type': `multipart/form-data; boundary=${bd}`,
                  'Content-Length': Buffer.byteLength(body),
                  'Cookie': `.ROBLOSECURITY=${cookie.trim()}`,
                  'x-csrf-token': csrf,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                },
              }, res2 => {
                let b = ''; res2.on('data', c => (b += c));
                res2.on('end', () => resolve({ status: res2.statusCode, body: b }));
              });
              req2.setTimeout(12000, () => req2.destroy(new Error('timeout')));
              req2.on('error', reject);
              req2.write(body);
              req2.end();
            });
          };

          const r = await multipartReq(
            'apis.roblox.com',
            `/developer-products/v2/universes/${universeId}/developer-products`,
            'POST',
            { name, description: p.description || '', priceInRobux: String(price) }
          );
          console.log(`[create-products] name="${name}" status=${r.status} body=${r.body.slice(0,200)}`);

          if (r.status < 300) {
            // Parse the new product ID from the create response
            let newId = null;
            try {
              const rd = JSON.parse(r.body);
              newId = String(rd.developerProductId || rd.productId || rd.id || '');
            } catch { /* ignore */ }

            // Set price + isForSale on the newly created product.
            // Key: use field name "price" (not "priceInRobux") — the v2 PATCH accepts
            // "price" + "isForSale: true" in one call for fresh products with null price.
            if (newId && price > 0) {
              const patchPath = `/developer-products/v2/universes/${universeId}/developer-products/${newId}`;
              try {
                await sleep(400);
                const pr = await multipartReq('apis.roblox.com', patchPath, 'PATCH', {
                  price: String(price), isForSale: 'true',
                });
                console.log(`[create-products] price+sale PATCH id=${newId} status=${pr.status} body=${pr.body.slice(0,300)}`);
              } catch (e) {
                console.log(`[create-products] price+sale PATCH error: ${e.message}`);
              }
            }

            success.push({ originalId: p.id, newId: newId || null, name });
          } else {
            failed.push({ id: p.id, name, error: `HTTP ${r.status} — ${r.body.slice(0,300)}` });
          }
        } catch (e) {
          failed.push({ id: p.id, error: e.message });
        }
      }
      send(res, 200, { success, failed });
      return;
    }

    // ── Temporary price probe endpoint ────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/price-probe') {
      const { cookie, universeId, productId, price } = await parseBody(req);
      const csrf = await getCsrf(cookie.trim());
      const results = {};

      const makeMultipart = (fields) => {
        const boundary = `----FB${Date.now()}`;
        const body = Object.entries(fields).map(([k, v]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`
        ).join('\r\n') + `\r\n--${boundary}--\r\n`;
        return { boundary, body };
      };

      const probe = async (label, hostname, path, method, fields) => {
        const { boundary, body } = makeMultipart(fields);
        return new Promise(res2 => {
          const req2 = https.request({ hostname, path, method, headers: {
            'Accept': 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body), 'Cookie': `.ROBLOSECURITY=${cookie.trim()}`,
            'x-csrf-token': csrf, 'User-Agent': 'Mozilla/5.0',
          }}, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ results[label]=`${r.statusCode}:${b.slice(0,120)}`; res2(); }); });
          req2.on('error', e => { results[label]=`ERR:${e.message}`; res2(); });
          req2.write(body); req2.end();
        });
      };

      // Helper to GET product details and extract price info
      const checkProduct = async (label) => {
        try {
          const r = await robloxReq({ hostname: 'apis.roblox.com', path: `/developer-products/v1/developer-products/${productId}/details`, cookie: cookie.trim() });
          const d = r.status === 200 ? JSON.parse(r.body) : {};
          results[label + '_verify'] = `price=${d.PriceInRobux ?? 'null'} isForSale=${d.IsForSale ?? 'null'}`;
        } catch (e) { results[label + '_verify'] = `ERR:${e.message}`; }
      };

      const base = `/developer-products/v2/universes/${universeId}/developer-products/${productId}`;

      // Test develop.roblox.com v1 POST (JSON) — the old update endpoint
      await (async () => {
        const label = 'develop_v1_POST';
        try {
          const r = await robloxReq({ hostname: 'develop.roblox.com', path: `/v1/universes/${universeId}/developer-products/${productId}`, method: 'POST', cookie: cookie.trim(), csrf, body: { priceInRobux: Number(price), name: 'Steal', description: '' } });
          results[label] = `${r.status}:${r.body.slice(0,120)}`;
        } catch (e) { results[label] = `ERR:${e.message}`; }
        await checkProduct(label);
      })();

      // Test PATCH with name included (maybe name is required)
      await probe('PATCH_withName', 'apis.roblox.com', base, 'PATCH', { name: 'Steal', priceInRobux: String(price), isForSale: 'true' });
      await checkProduct('PATCH_withName');

      await probe('PATCH_priceInRobux',    'apis.roblox.com', base, 'PATCH', { priceInRobux: String(price), isForSale: 'true' });
      await checkProduct('PATCH_priceInRobux');

      await probe('POST_priceInRobux',     'apis.roblox.com', base, 'POST',  { priceInRobux: String(price), isForSale: 'true' });
      await probe('PATCH_price',           'apis.roblox.com', base, 'PATCH', { price: String(price), isForSale: 'true' });
      await probe('PATCH_defaultPrice',    'apis.roblox.com', base, 'PATCH', { defaultPriceInRobux: String(price), isForSale: 'true' });
      await probe('PATCH_price_sub',       'apis.roblox.com', `${base}/price`, 'PATCH', { priceInRobux: String(price) });
      await probe('POST_price_sub',        'apis.roblox.com', `${base}/price`, 'POST',  { priceInRobux: String(price) });

      console.log('[price-probe]', JSON.stringify(results));
      send(res, 200, results); return;
    }

    if (method === 'POST' && pathname === '/api/update-prices') {
      const { cookie, universeId, updates } = await parseBody(req);
      if (!cookie || !universeId || !Array.isArray(updates)) {
        send(res, 400, { error: 'cookie, universeId, updates required' }); return;
      }
      send(res, 200, await updatePrices(universeId, updates, cookie.trim()));
      return;
    }

    if (method === 'POST' && pathname === '/api/toggle-privacy') {
      const { cookie, universeId, makePrivate } = await parseBody(req);
      if (!cookie || !universeId) { send(res, 400, { error: 'cookie and universeId required' }); return; }
      const csrf = await getCsrf(cookie.trim());
      if (!csrf) { send(res, 401, { error: 'Could not get CSRF token' }); return; }
      const action = makePrivate ? 'deactivate' : 'activate';
      const r = await robloxReq({
        hostname: 'develop.roblox.com',
        path:     `/v1/universes/${universeId}/${action}`,
        method:   'POST',
        cookie:   cookie.trim(),
        csrf,
      });
      console.log(`[toggle-privacy] universe=${universeId} action=${action} status=${r.status} body=${r.body.slice(0,200)}`);
      if (r.status < 300) {
        send(res, 200, { ok: true, isActive: !makePrivate });
      } else {
        send(res, 200, { ok: false, error: `HTTP ${r.status} — ${r.body.slice(0, 200)}` });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/publish-place') {
      const { apiKey, universeId, placeId, fileBase64 } = await parseBody(req);
      if (!apiKey || !universeId || !placeId || !fileBase64) {
        send(res, 400, { error: 'apiKey, universeId, placeId, fileBase64 required' }); return;
      }
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const firstBytes = fileBuffer.slice(0, 5).toString('utf8');
      const contentType = firstBytes.startsWith('<') ? 'application/xml' : 'application/octet-stream';
      const result = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'apis.roblox.com',
          path: `/universes/v1/universe/${universeId}/place/${placeId}/versions?versionType=Published`,
          method: 'POST',
          headers: {
            'x-api-key': apiKey.trim(),
            'Content-Type': contentType,
            'Content-Length': fileBuffer.length,
          },
        }, res2 => {
          let b = ''; res2.on('data', c => (b += c));
          res2.on('end', () => resolve({ status: res2.statusCode, body: b }));
        });
        r.setTimeout(60000, () => r.destroy(new Error('timeout')));
        r.on('error', reject);
        r.write(fileBuffer);
        r.end();
      });
      console.log(`[publish-place] universe=${universeId} place=${placeId} status=${result.status} body=${result.body.slice(0,200)}`);
      if (result.status < 300) {
        let version = null;
        try { version = JSON.parse(result.body).versionNumber || null; } catch {}
        send(res, 200, { ok: true, version });
      } else {
        send(res, 200, { ok: false, error: `HTTP ${result.status} — ${result.body.slice(0,300)}` });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/update-game-info') {
      const { cookie, universeId, description, name } = await parseBody(req);
      if (!cookie || !universeId) { send(res, 400, { error: 'cookie and universeId required' }); return; }
      const csrf = await getCsrf(cookie.trim());
      if (!csrf) { send(res, 401, { error: 'Could not get CSRF token' }); return; }
      const body = {};
      if (description !== undefined) body.description = description;
      if (name !== undefined) body.name = name;
      const r = await robloxReq({
        hostname: 'develop.roblox.com',
        path: `/v1/universes/${universeId}`,
        method: 'PATCH',
        cookie: cookie.trim(),
        csrf,
        body,
      });
      console.log(`[update-game-info] universe=${universeId} status=${r.status} body=${r.body.slice(0,200)}`);
      send(res, 200, r.status < 300 ? { ok: true } : { ok: false, error: `HTTP ${r.status} — ${r.body.slice(0,200)}` });
      return;
    }

    if (method === 'POST' && pathname === '/api/upload-thumbnail') {
      const { apiKey, universeId, imageBase64 } = await parseBody(req);
      if (!apiKey || !universeId || !imageBase64) { send(res, 400, { error: 'apiKey, universeId, imageBase64 required' }); return; }
      const imgBuf = Buffer.from(imageBase64, 'base64');
      const magic4 = imgBuf.slice(0, 4);
      const isPng = magic4[0] === 0x89 && magic4[1] === 0x50;
      const mime = isPng ? 'image/png' : 'image/jpeg';
      const ext  = isPng ? 'thumbnail.png' : 'thumbnail.jpg';
      const boundary = '----RblxBoundary' + Date.now();
      const CRLF = '\r\n';
      const partHead = Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${ext}"${CRLF}` +
        `Content-Type: ${mime}${CRLF}${CRLF}`
      );
      const partTail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
      const formBody = Buffer.concat([partHead, imgBuf, partTail]);
      const result = await new Promise((resolve, reject) => {
        const r2 = https.request({
          hostname: 'apis.roblox.com',
          path: `/game-thumbnails/v1/games/${universeId}/images`,
          method: 'POST',
          headers: {
            'x-api-key': apiKey.trim(),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': formBody.length,
          },
        }, res2 => {
          let b = ''; res2.on('data', c => (b += c));
          res2.on('end', () => resolve({ status: res2.statusCode, body: b }));
        });
        r2.setTimeout(30000, () => r2.destroy(new Error('timeout')));
        r2.on('error', reject);
        r2.write(formBody); r2.end();
      });
      console.log(`[upload-thumbnail] universe=${universeId} status=${result.status} body=${result.body.slice(0,200)}`);
      send(res, 200, result.status < 300 ? { ok: true } : { ok: false, error: `HTTP ${result.status} — ${result.body.slice(0,200)}` });
      return;
    }

    if (method === 'POST' && pathname === '/api/create-game') {
      const { apiKey, universeId, name, description } = await parseBody(req);
      if (!apiKey || !universeId || !name) {
        send(res, 400, { error: 'apiKey, universeId and name required' }); return;
      }
      // Create a new place within the given universe using Open Cloud API key auth
      const r = await robloxReq({
        hostname: 'apis.roblox.com',
        path: `/universes/v1/universes/${String(universeId).trim()}/places`,
        method: 'POST',
        apiKey: apiKey.trim(),
        body: { name: name.trim(), description: description || '' },
      });
      console.log(`[create-game] universe=${universeId} status=${r.status} body=${r.body.slice(0,300)}`);
      if (r.status < 300) {
        const d = JSON.parse(r.body);
        const placeId = String(d.placeId || d.id || '');
        send(res, 200, { ok: true, universeId: String(universeId), placeId });
      } else {
        send(res, 200, { ok: false, error: `HTTP ${r.status} — ${r.body.slice(0,300)}` });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/parse-rbxl') {
      const { fileBase64 } = await parseBody(req);
      if (!fileBase64) { send(res, 400, { error: 'fileBase64 required' }); return; }
      try {
        const buf  = Buffer.from(fileBase64, 'base64');
        const text = rbxlExtractText(buf);
        // Count extracted numeric IDs as a rough script-count proxy
        const idCount = (text.match(/\b\d{6,12}\b/g) || []).length;
        console.log(`[parse-rbxl] extracted ${text.length} chars, ~${idCount} numeric IDs`);
        send(res, 200, { text, scriptCount: idCount });
      } catch (e) {
        console.error('[parse-rbxl] error:', e.message);
        send(res, 500, { error: `Parse failed: ${e.message}` });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/modify-rbxl') {
      const { fileBase64, idMap } = await parseBody(req);
      if (!fileBase64 || !idMap || typeof idMap !== 'object') {
        send(res, 400, { error: 'fileBase64 and idMap required' }); return;
      }
      try {
        const buf      = Buffer.from(fileBase64, 'base64');
        const modified = await rbxlModify(buf, idMap);
        const replaced = Object.keys(idMap).length;
        console.log(`[modify-rbxl] applied ${replaced} ID replacements, out size=${modified.length} bytes (${zstdEnc ? 'zstd' : 'uncompressed'})`);
        send(res, 200, { fileBase64: modified.toString('base64'), replaced });
      } catch (e) {
        console.error('[modify-rbxl] error:', e.message);
        send(res, 500, { error: `Modify failed: ${e.message}` });
      }
      return;
    }

    serveStatic(res, pathname);

  } catch (e) {
    console.error(e.message);
    send(res, 500, { error: e.message });
  }

}).listen(PORT, () => console.log(`Product Scanner → http://localhost:${PORT}`));

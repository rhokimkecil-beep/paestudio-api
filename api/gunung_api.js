import { createClient } from "@libsql/client";

const API_TOKEN = process.env.API_TOKEN || "ONIUM_UPLOAD_B2EF2EFA48AD790B36503EB6B159544F";
const APP_VERSION = "1.0.0";
const JSON_CHUNK_SIZE = 900000; // 900KB per chunk (Turso safe limit)

function getDb() {
  return createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });
}

async function initDb(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama TEXT NOT NULL,
      deskripsi TEXT DEFAULT '',
      frame_count INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS route_json_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rjc_route ON route_json_chunks(route_id, chunk_index);

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_upload ON chunks(upload_id, chunk_index);
  `);
}

function ok(res, data) {
  return res.status(200).json({ success: true, ...data });
}

function err(res, msg, code = 400) {
  return res.status(code).json({ success: false, error: msg });
}

function checkToken(req, res) {
  const token = req.query.token || req.body?.token || "";
  if (token !== API_TOKEN) { err(res, "Token tidak valid", 403); return false; }
  return true;
}

// Simpan JSON besar dalam potongan kecil
async function saveJsonChunked(db, routeId, jsonStr) {
  // Hapus chunks lama
  await db.execute({ sql: `DELETE FROM route_json_chunks WHERE route_id = ?`, args: [routeId] });

  const total = Math.ceil(jsonStr.length / JSON_CHUNK_SIZE);
  for (let i = 0; i < total; i++) {
    const chunk = jsonStr.slice(i * JSON_CHUNK_SIZE, (i + 1) * JSON_CHUNK_SIZE);
    await db.execute({
      sql: `INSERT INTO route_json_chunks (route_id, chunk_index, data) VALUES (?, ?, ?)`,
      args: [routeId, i, chunk],
    });
  }
}

// Ambil JSON dari chunks
async function getJsonChunked(db, routeId) {
  const rows = await db.execute({
    sql: `SELECT data FROM route_json_chunks WHERE route_id = ? ORDER BY chunk_index ASC`,
    args: [routeId],
  });
  if (!rows.rows.length) return null;
  return rows.rows.map(r => r.data).join("");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query.action || "").trim();
  const db = getDb();

  try { await initDb(db); } catch (e) { return err(res, "DB init error: " + e.message, 500); }

  try {
    switch (action) {

      case "ping":
        return ok(res, { message: "PaeStudio API OK", version: APP_VERSION, time: new Date().toISOString() });

      case "list_routes": {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);
        const routes = await db.execute({
          sql: `SELECT id, nama, deskripsi, frame_count, file_size, views, created_at, updated_at FROM routes ORDER BY id DESC LIMIT ? OFFSET ?`,
          args: [limit, offset],
        });
        const total = await db.execute(`SELECT COUNT(*) as cnt FROM routes`);
        return ok(res, { routes: routes.rows, total: total.rows[0].cnt, limit, offset });
      }

      case "search": {
        const q = (req.query.q || "").trim();
        if (!q) return err(res, '"q" wajib diisi');
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);
        const routes = await db.execute({
          sql: `SELECT id, nama, deskripsi, frame_count, file_size, views, created_at FROM routes WHERE nama LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
          args: [`%${q}%`, limit, offset],
        });
        const total = await db.execute({ sql: `SELECT COUNT(*) as cnt FROM routes WHERE nama LIKE ?`, args: [`%${q}%`] });
        return ok(res, { routes: routes.rows, total: total.rows[0].cnt, keyword: q });
      }

      case "get_route_info": {
        const id = parseInt(req.query.id) || 0;
        if (!id) return err(res, '"id" wajib diisi');
        const route = await db.execute({ sql: `SELECT * FROM routes WHERE id = ?`, args: [id] });
        if (!route.rows.length) return err(res, "Route tidak ditemukan", 404);
        return ok(res, { route: route.rows[0] });
      }

      case "get_json": {
        const id = parseInt(req.query.id) || 0;
        if (!id) return err(res, '"id" wajib diisi');
        const route = await db.execute({ sql: `SELECT id, nama FROM routes WHERE id = ?`, args: [id] });
        if (!route.rows.length) return err(res, "Route tidak ditemukan", 404);

        const json = await getJsonChunked(db, id);
        if (!json) return err(res, "JSON tidak ditemukan", 404);

        await db.execute({ sql: `UPDATE routes SET views = views + 1 WHERE id = ?`, args: [id] });

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(json);
      }

      case "get_json_preview": {
        const id = parseInt(req.query.id) || 0;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
        if (!id) return err(res, '"id" wajib diisi');
        const json = await getJsonChunked(db, id);
        if (!json) return err(res, "Route tidak ditemukan", 404);
        const frames = JSON.parse(json);
        const preview = Array.isArray(frames) ? frames.slice(0, limit) : [];
        return ok(res, { frames: preview, shown: preview.length });
      }

      case "upload_json_raw": {
        if (!checkToken(req, res)) return;
        const nama = (req.query.nama || "").trim();
        const deskripsi = (req.query.deskripsi || "").trim();
        if (!nama) return err(res, '"nama" wajib diisi');

        let body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        if (!body || body.length < 5) return err(res, "Body JSON kosong");

        let decoded;
        try { decoded = JSON.parse(body); } catch (e) { return err(res, "JSON tidak valid: " + e.message); }
        if (!Array.isArray(decoded)) return err(res, "Format JSON tidak dikenal");

        const frameCount = decoded.length;
        const fileSize = body.length;

        const existing = await db.execute({ sql: `SELECT id FROM routes WHERE nama = ?`, args: [nama] });
        let routeId, replaced = false;

        if (existing.rows.length) {
          routeId = existing.rows[0].id;
          replaced = true;
          await db.execute({
            sql: `UPDATE routes SET deskripsi=?, frame_count=?, file_size=?, updated_at=datetime('now') WHERE id=?`,
            args: [deskripsi, frameCount, fileSize, routeId],
          });
        } else {
          const result = await db.execute({
            sql: `INSERT INTO routes (nama, deskripsi, frame_count, file_size) VALUES (?, ?, ?, ?)`,
            args: [nama, deskripsi, frameCount, fileSize],
          });
          routeId = Number(result.lastInsertRowid);
        }

        await saveJsonChunked(db, routeId, body);

        return ok(res, {
          id: routeId, nama, frame_count: frameCount, file_size: fileSize,
          replaced, replace_count: replaced ? 1 : 0,
          message: replaced ? "Route diperbarui" : "Route baru ditambahkan",
          link: `https://${req.headers.host}/route.php?id=${routeId}`,
        });
      }

      case "upload_json_chunk": {
        if (!checkToken(req, res)) return;
        const nama = (req.query.nama || "").trim();
        const deskripsi = (req.query.deskripsi || "").trim();
        const uploadId = (req.query.upload_id || "").trim();
        const chunkIndex = parseInt(req.query.chunk_index) || 0;
        const totalChunks = parseInt(req.query.total_chunks) || 0;

        if (!nama) return err(res, '"nama" wajib diisi');
        if (!uploadId) return err(res, '"upload_id" wajib diisi');
        if (chunkIndex < 1) return err(res, '"chunk_index" harus >= 1');
        if (totalChunks < 1) return err(res, '"total_chunks" harus >= 1');

        let chunkData = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        if (!chunkData) return err(res, "Chunk data kosong");

        if (chunkIndex === 1) {
          const cutoff = new Date(Date.now() - 3600000).toISOString();
          await db.execute({ sql: `DELETE FROM chunks WHERE created_at < ?`, args: [cutoff] });
        }

        await db.execute({
          sql: `INSERT INTO chunks (upload_id, chunk_index, total_chunks, data) VALUES (?, ?, ?, ?)`,
          args: [uploadId, chunkIndex, totalChunks, chunkData],
        });

        const received = await db.execute({ sql: `SELECT COUNT(*) as cnt FROM chunks WHERE upload_id = ?`, args: [uploadId] });
        const receivedCount = Number(received.rows[0].cnt);

        if (receivedCount < totalChunks) {
          return ok(res, { chunk_received: chunkIndex, total_chunks: totalChunks, chunks_so_far: receivedCount, complete: false, message: `Chunk ${chunkIndex}/${totalChunks} diterima` });
        }

        const allChunks = await db.execute({ sql: `SELECT data FROM chunks WHERE upload_id = ? ORDER BY chunk_index ASC`, args: [uploadId] });
        if (allChunks.rows.length !== totalChunks) return err(res, "Gagal menggabungkan chunk");

        const fullJson = allChunks.rows.map(r => r.data).join("");

        let decoded;
        try { decoded = JSON.parse(fullJson); } catch (e) {
          await db.execute({ sql: `DELETE FROM chunks WHERE upload_id = ?`, args: [uploadId] });
          return err(res, "JSON tidak valid: " + e.message);
        }
        if (!Array.isArray(decoded)) {
          await db.execute({ sql: `DELETE FROM chunks WHERE upload_id = ?`, args: [uploadId] });
          return err(res, "Format JSON tidak dikenal");
        }

        const frameCount = decoded.length;
        const fileSize = fullJson.length;

        const existing = await db.execute({ sql: `SELECT id FROM routes WHERE nama = ?`, args: [nama] });
        let routeId, replaced = false;

        if (existing.rows.length) {
          routeId = existing.rows[0].id;
          replaced = true;
          await db.execute({
            sql: `UPDATE routes SET deskripsi=?, frame_count=?, file_size=?, updated_at=datetime('now') WHERE id=?`,
            args: [deskripsi, frameCount, fileSize, routeId],
          });
        } else {
          const result = await db.execute({
            sql: `INSERT INTO routes (nama, deskripsi, frame_count, file_size) VALUES (?, ?, ?, ?)`,
            args: [nama, deskripsi, frameCount, fileSize],
          });
          routeId = Number(result.lastInsertRowid);
        }

        await saveJsonChunked(db, routeId, fullJson);
        await db.execute({ sql: `DELETE FROM chunks WHERE upload_id = ?`, args: [uploadId] });

        return ok(res, {
          id: routeId, nama, frame_count: frameCount, file_size: fileSize,
          replaced, replace_count: replaced ? 1 : 0, complete: true,
          message: replaced ? "Route diperbarui" : "Route baru ditambahkan",
          link: `https://${req.headers.host}/route.php?id=${routeId}`,
        });
      }

      case "delete_route": {
        if (!checkToken(req, res)) return;
        const id = parseInt(req.query.id) || 0;
        if (!id) return err(res, '"id" wajib diisi');
        const route = await db.execute({ sql: `SELECT id, nama FROM routes WHERE id = ?`, args: [id] });
        if (!route.rows.length) return err(res, "Route tidak ditemukan", 404);
        await db.execute({ sql: `DELETE FROM route_json_chunks WHERE route_id = ?`, args: [id] });
        await db.execute({ sql: `DELETE FROM routes WHERE id = ?`, args: [id] });
        return ok(res, { deleted_id: id, nama: route.rows[0].nama });
      }

      default:
        return err(res, "Action tidak dikenal. Tersedia: ping, upload_json_raw, upload_json_chunk, get_json, get_json_preview, list_routes, get_route_info, delete_route, search");
    }
  } catch (e) {
    return err(res, "Server error: " + e.message, 500);
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: "50mb" } },
};

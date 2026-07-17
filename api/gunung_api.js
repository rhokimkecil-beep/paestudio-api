// ═══════════════════════════════════════════════
//  PaeStudio Route Hub — API (Vercel + Turso)
//  Kompatibel dengan ONIUM Recorder & PaeStudio Loader
// ═══════════════════════════════════════════════

import { createClient } from "@libsql/client";

const API_TOKEN = process.env.API_TOKEN || "ONIUM_UPLOAD_B2EF2EFA48AD790B36503EB6B159544F";
const APP_VERSION = "1.0.0";

// ── DB Client ────────────────────────────────────
function getDb() {
  return createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });
}

// ── Init Tables ──────────────────────────────────
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

    CREATE TABLE IF NOT EXISTS route_json (
      route_id INTEGER PRIMARY KEY,
      json_content TEXT NOT NULL,
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );

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

// ── Helpers ──────────────────────────────────────
function ok(res, data) {
  return res.status(200).json({ success: true, ...data });
}

function err(res, msg, code = 400) {
  return res.status(code).json({ success: false, error: msg });
}

function checkToken(req, res) {
  const token = req.query.token || req.body?.token || "";
  if (token !== API_TOKEN) {
    err(res, "Token tidak valid", 403);
    return false;
  }
  return true;
}

// ── Main Handler ─────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const action = (req.query.action || "").trim();
  const db = getDb();

  try {
    await initDb(db);
  } catch (e) {
    return err(res, "DB init error: " + e.message, 500);
  }

  try {
    switch (action) {

      // ── PING ──────────────────────────────────
      case "ping": {
        return ok(res, {
          message: "PaeStudio API OK",
          version: APP_VERSION,
          time: new Date().toISOString(),
        });
      }

      // ── LIST_ROUTES ───────────────────────────
      case "list_routes": {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);

        const routes = await db.execute({
          sql: `SELECT id, nama, deskripsi, frame_count, file_size, views, created_at, updated_at 
                FROM routes ORDER BY id DESC LIMIT ? OFFSET ?`,
          args: [limit, offset],
        });

        const total = await db.execute(`SELECT COUNT(*) as cnt FROM routes`);

        return ok(res, {
          routes: routes.rows,
          total: total.rows[0].cnt,
          limit,
          offset,
        });
      }

      // ── SEARCH ────────────────────────────────
      case "search": {
        const q = (req.query.q || "").trim();
        if (!q) return err(res, '"q" wajib diisi');

        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);

        const routes = await db.execute({
          sql: `SELECT id, nama, deskripsi, frame_count, file_size, views, created_at 
                FROM routes WHERE nama LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
          args: [`%${q}%`, limit, offset],
        });

        const total = await db.execute({
          sql: `SELECT COUNT(*) as cnt FROM routes WHERE nama LIKE ?`,
          args: [`%${q}%`],
        });

        return ok(res, {
          routes: routes.rows,
          total: total.rows[0].cnt,
          keyword: q,
        });
      }

      // ── GET_ROUTE_INFO ────────────────────────
      case "get_route_info": {
        const id = parseInt(req.query.id) || 0;
        if (!id) return err(res, '"id" wajib diisi');

        const route = await db.execute({
          sql: `SELECT id, nama, deskripsi, frame_count, file_size, views, created_at FROM routes WHERE id = ?`,
          args: [id],
        });

        if (!route.rows.length) return err(res, "Route tidak ditemukan", 404);

        return ok(res, { route: route.rows[0] });
      }

      // ── GET_JSON ──────────────────────────────
      case "get_json": {
        const id = parseInt(req.query.id) || 0;
        if (!id) return err(res, '"id" wajib diisi');

        const route = await db.execute({
          sql: `SELECT id, nama FROM routes WHERE id = ?`,
          args: [id],
        });
        if (!route.rows.length) return err(res, "Route tidak ditemukan", 404);

        const jsonRow = await db.execute({
          sql: `SELECT json_content FROM route_json WHERE route_id = ?`,
          args: [id],
        });
        if (!jsonRow.rows.length) return err(res, "JSON tidak ditemukan", 404);

        // Increment views
        await db.execute({
          sql: `UPDATE routes SET views = views + 1 WHERE id = ?`,
          args: [id],
        });

        // Kirim JSON langsung (bukan dibungkus {success: true})
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(jsonRow.rows[0].json_content);
      }

      // ── GET_JSON_PREVIEW ──────────────────────
      case "get_json_preview": {
        const id = parseInt(req.query.id) || 0;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
        if (!id) return err(res, '"id" wajib diisi');

        const jsonRow = await db.execute({
          sql: `SELECT json_content FROM route_json WHERE route_id = ?`,
          args: [id],
        });
        if (!jsonRow.rows.length) return err(res, "Route tidak ditemukan", 404);

        const frames = JSON.parse(jsonRow.rows[0].json_content);
        const preview = Array.isArray(frames) ? frames.slice(0, limit) : [];

        return ok(res, { frames: preview, shown: preview.length });
      }

      // ── UPLOAD_JSON_RAW ───────────────────────
      case "upload_json_raw": {
        if (!checkToken(req, res)) return;

        const nama = (req.query.nama || "").trim();
        const deskripsi = (req.query.deskripsi || "").trim();
        if (!nama) return err(res, '"nama" wajib diisi');

        // Baca body
        let body = "";
        if (typeof req.body === "string") {
          body = req.body;
        } else if (req.body) {
          body = JSON.stringify(req.body);
        }

        if (!body || body.length < 5) return err(res, "Body JSON kosong");

        let decoded;
        try {
          decoded = JSON.parse(body);
        } catch (e) {
          return err(res, "JSON tidak valid: " + e.message);
        }

        if (!Array.isArray(decoded)) return err(res, "Format JSON tidak dikenal (harus array frames)");

        const frameCount = decoded.length;
        const fileSize = body.length;

        // Cek existing
        const existing = await db.execute({
          sql: `SELECT id FROM routes WHERE nama = ?`,
          args: [nama],
        });

        let routeId;
        let replaced = false;

        if (existing.rows.length) {
          routeId = existing.rows[0].id;
          replaced = true;
          await db.execute({
            sql: `UPDATE routes SET deskripsi=?, frame_count=?, file_size=?, updated_at=datetime('now') WHERE id=?`,
            args: [deskripsi, frameCount, fileSize, routeId],
          });
          await db.execute({
            sql: `UPDATE route_json SET json_content=? WHERE route_id=?`,
            args: [body, routeId],
          });
        } else {
          const result = await db.execute({
            sql: `INSERT INTO routes (nama, deskripsi, frame_count, file_size) VALUES (?, ?, ?, ?)`,
            args: [nama, deskripsi, frameCount, fileSize],
          });
          routeId = Number(result.lastInsertRowid);
          await db.execute({
            sql: `INSERT INTO route_json (route_id, json_content) VALUES (?, ?)`,
            args: [routeId, body],
          });
        }

        return ok(res, {
          id: routeId,
          nama,
          frame_count: frameCount,
          file_size: fileSize,
          replaced,
          replace_count: replaced ? 1 : 0,
          message: replaced ? "Route diperbarui" : "Route baru ditambahkan",
          link: `https://${req.headers.host}/route.php?id=${routeId}`,
        });
      }

      // ── UPLOAD_JSON_CHUNK ─────────────────────
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

        let chunkData = "";
        if (typeof req.body === "string") {
          chunkData = req.body;
        } else if (req.body) {
          chunkData = JSON.stringify(req.body);
        }

        if (!chunkData) return err(res, "Chunk data kosong");

        // Bersihkan chunk lama kalau chunk pertama
        if (chunkIndex === 1) {
          const cutoff = new Date(Date.now() - 3600000).toISOString();
          await db.execute({
            sql: `DELETE FROM chunks WHERE created_at < ?`,
            args: [cutoff],
          });
        }

        // Simpan chunk
        await db.execute({
          sql: `INSERT INTO chunks (upload_id, chunk_index, total_chunks, data) VALUES (?, ?, ?, ?)`,
          args: [uploadId, chunkIndex, totalChunks, chunkData],
        });

        const received = await db.execute({
          sql: `SELECT COUNT(*) as cnt FROM chunks WHERE upload_id = ?`,
          args: [uploadId],
        });

        const receivedCount = Number(received.rows[0].cnt);

        if (receivedCount < totalChunks) {
          return ok(res, {
            chunk_received: chunkIndex,
            total_chunks: totalChunks,
            chunks_so_far: receivedCount,
            complete: false,
            message: `Chunk ${chunkIndex}/${totalChunks} diterima`,
          });
        }

        // Gabungkan semua chunk
        const allChunks = await db.execute({
          sql: `SELECT data FROM chunks WHERE upload_id = ? ORDER BY chunk_index ASC`,
          args: [uploadId],
        });

        if (allChunks.rows.length !== totalChunks) {
          return err(res, "Gagal menggabungkan chunk (jumlah tidak cocok)");
        }

        const fullJson = allChunks.rows.map((r) => r.data).join("");

        let decoded;
        try {
          decoded = JSON.parse(fullJson);
        } catch (e) {
          await db.execute({ sql: `DELETE FROM chunks WHERE upload_id = ?`, args: [uploadId] });
          return err(res, "JSON tidak valid setelah digabungkan: " + e.message);
        }

        if (!Array.isArray(decoded)) {
          await db.execute({ sql: `DELETE FROM chunks WHERE upload_id = ?`, args: [uploadId] });
          return err(res, "Format JSON tidak dikenal");
        }

        const frameCount = decoded.length;
        const fileSize = fullJson.length;

        const existing = await db.execute({
          sql: `SELECT id FROM routes WHERE nama = ?`,
          args: [nama],
        });

        let routeId;
        let replaced = false;

        if (existing.rows.length) {
          routeId = existing.rows[0].id;
          replaced = true;
          await db.execute({
            sql: `UPDATE routes SET deskripsi=?, frame_count=?, file_size=?, updated_at=datetime('now') WHERE id=?`,
            args: [deskripsi, frameCount, fileSize, routeId],
          });
          await db.execute({
            sql: `UPDATE route_json SET json_content=? WHERE route_id=?`,
            args: [fullJson, routeId],
          });
        } else {
          const result = await db.execute({
            sql: `INSERT INTO routes (nama, deskripsi, frame_count, file_size) VALUES (?, ?, ?, ?)`,
            args: [nama, deskripsi, frameCount, fileSize],
          });
          routeId = Number(result.lastInsertRowid);
          await db.execute({
            sql: `INSERT INTO route_json (route_id, json_content) VALUES (?, ?)`,
            args: [routeId, fullJson],
          });
        }

        // Hapus chunks temp
        await db.execute({ sql: `DELETE FROM chunks WHERE upload_id = ?`, args: [uploadId] });

        return ok(res, {
          id: routeId,
          nama,
          frame_count: frameCount,
          file_size: fileSize,
          replaced,
          replace_count: replaced ? 1 : 0,
          complete: true,
          message: replaced ? "Route diperbarui" : "Route baru ditambahkan",
          link: `https://${req.headers.host}/route.php?id=${routeId}`,
        });
      }

      // ── DELETE_ROUTE ──────────────────────────
      case "delete_route": {
        if (!checkToken(req, res)) return;

        const id = parseInt(req.query.id) || 0;
        if (!id) return err(res, '"id" wajib diisi');

        const route = await db.execute({
          sql: `SELECT id, nama FROM routes WHERE id = ?`,
          args: [id],
        });
        if (!route.rows.length) return err(res, "Route tidak ditemukan", 404);

        await db.execute({ sql: `DELETE FROM route_json WHERE route_id = ?`, args: [id] });
        await db.execute({ sql: `DELETE FROM routes WHERE id = ?`, args: [id] });

        return ok(res, { deleted_id: id, nama: route.rows[0].nama });
      }

      // ── DEFAULT ───────────────────────────────
      default: {
        return err(res, "Action tidak dikenal. Tersedia: ping, upload_json_raw, upload_json_chunk, get_json, get_json_preview, list_routes, get_route_info, delete_route, search");
      }
    }
  } catch (e) {
    return err(res, "Server error: " + e.message, 500);
  }
}

// Config untuk Vercel — izinkan raw body
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "50mb",
    },
  },
};

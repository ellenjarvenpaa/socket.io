import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { availableParallelism } from "node:os";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }

  setupPrimary();
} else {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      room TEXT,
      content TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter(),
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });

  io.on("connection", async (socket) => {
    socket.on("join room", async (room) => {
      socket.join(room);

      // Retrieve the last 50 messages from the database for this room
      const messages = await db.all(
        "SELECT content FROM messages WHERE room = ? ORDER BY id DESC LIMIT 50",
        room
      );

      // Send messages to the client in the correct order
      socket.emit(
        "room messages",
        messages.reverse().map((row) => row.content)
      );
    });

    socket.on("leave room", (room) => {
      socket.leave(room);
    });

    socket.on(
      "chat message",
      async ({ room, message }, clientOffset, callback) => {
        let result;
        try {
          result = await db.run(
            "INSERT INTO messages (content, client_offset, room) VALUES (?, ?, ?)",
            message,
            clientOffset,
            room
          );
        } catch (e) {
          if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
            callback();
          } else {
            // nothing to do, just let the client retry
          }
          return;
        }

        // Emit the message only to the room it belongs to
        io.to(room).emit("chat message", message, result.lastID);
        callback();
      }
    );

    if (!socket.recovered) {
      socket.on("disconnect", async () => {
        const roomName = Array.from(socket.rooms)[1]; // Get the first room the socket is part of
        if (roomName) {
          try {
            await db.each(
              "SELECT id, content FROM messages WHERE id > ? AND room = ?",
              [socket.handshake.auth.serverOffset || 0, roomName],
              (_err, row) => {
                socket.emit("chat message", row.content, row.id);
              }
            );
          } catch (e) {
            // Handle the error if necessary
          }
        }
      });
    }
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}

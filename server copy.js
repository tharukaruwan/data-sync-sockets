// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

// Online MongoDB URI
const ONLINE_DB_URI = process.env.DB || 'mongodb+srv://areduglobe:QJXetE6HydeVuOg9@areduglobedb.iwzzl.mongodb.net/imake-test';
const PORT = process.env.PORT || 3011;

async function startServer() {
  // Connect to online MongoDB
  let client;
  try {
    client = await MongoClient.connect(ONLINE_DB_URI);
    console.log('🌐 Connected to Online MongoDB');
  } catch (err) {
    console.error('Fatal error connecting to MongoDB:', err);
    process.exit(1);
  }

  const db = client.db();
  const app = express();
  app.use(cors()); // Allow cross-origin requests

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);

    socket.on('sync-data', async (payload) => {
      const { collection: collName, document: doc, _id: queDocId } = payload;
      console.log(`📨 Received ${collName} document:`, doc);
      try {
        const coll = db.collection(collName);
        // Extract _id and prepare update data without immutable _id
        const { _id, ...data } = doc;
        const objectId = new ObjectId(_id);
        await coll.updateOne(
          { _id: objectId },
          { $set: data },
          { upsert: true }
        );
        console.log(`✔️ Document ${_id} upserted into ${collName} of queue id ${queDocId}`);
        socket.emit('ack', { status: 'saved', id: queDocId });
      } catch (err) {
        console.error('❌ Error syncing document:', err);
        socket.emit('ack', { status: 'error', error: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server exposed at http://0.0.0.0:${PORT}`);
  });
}

startServer();

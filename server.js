// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

// Online MongoDB URI
const ONLINE_DB_URI = 'mongodb+srv://areduglobe:QJXetE6HydeVuOg9@areduglobedb.iwzzl.mongodb.net/imake-test';

const app = express();
app.use(cors()); // Allow cross-origin requests

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// MongoDB connection
MongoClient.connect(ONLINE_DB_URI).then(client => {
  console.log('🌐 Connected to Online MongoDB');
  const db = client.db();
  const queue = db.collection('pending_queue');

  io.on('connection', socket => {
    console.log(`✅ Client connected: ${socket.id}`);

    socket.on('sync-data', async (doc) => {
      console.log('📨 Received document:', doc);
      try {
        await queue.updateOne(
          { _id: doc._id },
          { $set: doc },
          { upsert: true }
        );
        console.log(`✔️ Document ${doc._id} synced to online DB`);
        socket.emit('ack', { status: 'saved', id: doc._id });
      } catch (err) {
        console.error('❌ Error:', err);
        socket.emit('ack', { status: 'error', error: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });
  });

  server.listen(3005, '0.0.0.0', () => {
    console.log('🚀 Server exposed at http://0.0.0.0:3005');
  });
}).catch(console.error);

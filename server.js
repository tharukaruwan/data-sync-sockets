// server.js
const express       = require('express');
const http          = require('http');
const cors          = require('cors');
const { Server }    = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

const ONLINE_DB_URI     = process.env.DB || 'mongodb://127.0.0.1:27017/imake-satglobal';
const PORT              = process.env.PORT || 3011;
const SERVER_POLL_MS    = 2000;  // retry interval for server queue

// Revive $oid back to ObjectId
function reviveObjectIds(obj) {
  if (Array.isArray(obj)) {
    return obj.map(reviveObjectIds);
  } else if (obj && typeof obj === 'object') {
    const newObj = {};
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object' && '$oid' in obj[key]) {
        newObj[key] = new ObjectId(obj[key]['$oid']);
      } else {
        newObj[key] = reviveObjectIds(obj[key]);
      }
    }
    return newObj;
  }
  return obj;
}

async function startServer() {
  let client;
  try {
    client = await MongoClient.connect(ONLINE_DB_URI, { useUnifiedTopology: true });
    console.log('🌐 Connected to Online MongoDB');
  } catch (err) {
    console.error('💥 Fatal error connecting to MongoDB:', err);
    process.exit(1);
  }
  const db = client.db();
  const app = express();
  app.use(cors());
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  const pendingQueue = db.collection('pending_queue');

  async function getNextPending() {
    return pendingQueue.findOne({}, { sort: { _id: 1 } });
  }

  async function deletePending(id) {
    await pendingQueue.deleteOne({ _id: new ObjectId(id) });
    console.log(`🗑️  Deleted server-pending doc ${id}`);
  }

  io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);

    socket.on('sync-data', async (payload) => {
      const { collection: collName, document: doc, _id: queDocId } = payload;
      console.log(`📨 Received ${collName} document from client:`, doc);
      try {
        const revivedDoc = reviveObjectIds(doc);
        const { _id, ...data } = revivedDoc;
        const coll = db.collection(collName);
        await coll.updateOne(
          { _id },
          { $set: data },
          { upsert: true }
        );
        console.log(`✔️ Upserted doc ${_id} into ${collName}`);
        socket.emit('ack', { status: 'saved', id: queDocId });
      } catch (err) {
        console.error('❌ Error upserting client doc:', err);
        socket.emit('ack', { status: 'error', error: err.message });
      }
    });

    socket.on('server-ack', async ({ status, id }) => {
      if (status === 'received') {
        console.log(`📬 Client ${socket.id} ack’d server doc ${id}`);
        try {
          await deletePending(id);
        } catch (e) {
          console.error('❌ Failed to delete pending_queue doc:', e);
        }
      } else {
        console.warn(`⚠️ Client ${socket.id} reported error for doc ${id}:`, status);
      }
      serverSyncLoop(socket);
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });

    serverSyncLoop(socket);
  });

  async function serverSyncLoop(socket) {
    try {
      const doc = await getNextPending();
      if (doc) {
        console.log(`➡️ Pushing pending doc ${doc._id} to ${socket.id}`);
        socket.emit('server-sync', doc);
      } else {
        setTimeout(() => serverSyncLoop(socket), SERVER_POLL_MS);
      }
    } catch (err) {
      console.error('❌ Error in serverSyncLoop:', err);
      setTimeout(() => serverSyncLoop(socket), SERVER_POLL_MS);
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => console.error('💥 Uncaught server error:', err));
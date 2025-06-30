// server.js
const express       = require('express');
const http          = require('http');
const cors          = require('cors');
const { Server }    = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

const ONLINE_DB_URI     = process.env.DB || 'mongodb://127.0.0.1:27017/imake-satglobal';
const PORT              = process.env.PORT || 3011;
const SERVER_POLL_MS    = 2000;
const PUSH_LOCATIONS    = '68457e58000ebc17dd275782,68457e6e000ebc17dd275794,68457e86000ebc17dd2757a7';

function convertObjectIdStrings(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => convertObjectIdStrings(item));
  }

  if (obj && typeof obj === 'object') {
    const newObj = {};
    for (const [key, value] of Object.entries(obj)) {
      newObj[key] = convertObjectIdStrings(value);
    }
    return newObj;
  }

  if (typeof obj === 'string' && /^[a-f\d]{24}$/i.test(obj)) {
    try {
      return new ObjectId(obj);
    } catch (e) {
      return obj; // if somehow fails, return original
    }
  }

  return obj;
}

async function startServer() {
  // 1) Connect to MongoDB
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

  // 2) Prepare collections
  const pendingQueue = db.collection('pending_queue');

  // Helper: fetch the oldest pending doc
  async function getNextPending() {
    return pendingQueue.findOne({}, { sort: { _id: 1 } }); // IF NEEDED WE CAN ILLIMINATE ERRORS
  }

  // Helper: delete by queue doc _id
  async function deletePending(id) {
    await pendingQueue.deleteOne({ _id: new ObjectId(id) });
    console.log(`🗑️  Deleted server-pending doc ${id}`);
  }

  // 3) When any client connects…
  io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);

    // Save the client's location
    socket.on('register-location', (locationId) => {
      socket.locationId = locationId;
      console.log(`📍 Registered client ${socket.id} with location ${locationId}`);
      // Start the sync loop only after registration
      serverSyncLoop(socket);
    });

    // A) Handle incoming client → server sync-data
    socket.on('sync-data', async (payload) => {
      const { collection: collName, document: doc, _id: queDocId, locationTo, location, ts } = payload;
      console.log(`📨 Received ${collName} document from client:`, doc);
      // if (locationTo != SERVER_LOCATION) {
      //   console.error(`❌ Incorrect to location received doc ${queDocId} for ${locationTo}:`);
      //   socket.emit('ack', { status: 'error', error: `Incorrect to location received doc ${queDocId} for ${locationTo}:`, id: queDocId });
      //   return;
      // }
      try {
        // strip immutable _id on update
        const { _id, ...data } = doc;
        const coll = db.collection(collName);
        await coll.updateOne(
          { _id: new ObjectId(_id) },
          { $set: convertObjectIdStrings(data) },
          { upsert: true }
        );
        console.log(`✔️ Upserted doc ${_id} into ${collName}`);
        // ✅ Push to each location in PUSH_LOCATIONS
        const pushLocations = PUSH_LOCATIONS.split(',').map(id => id.trim());

        for (const pushLocation of pushLocations) {
          if (pushLocation === locationTo) continue;

          const queueDoc = {
            collection: collName,
            document: doc,
            location: location,
            locationTo: pushLocation,
            ts,
            error: false,
            errorMessage: null,
          };

          await db.collection('pending_queue').insertOne(queueDoc);
          console.log(`🆕 Queued doc ${doc._id} for sync to location ${pushLocation}`);
        }
        socket.emit('ack', { status: 'saved', id: queDocId });
      } catch (err) {
        console.error('❌ Error upserting client doc:', err);
        socket.emit('ack', { status: 'error', error: err.message, id: queDocId });
      }
    });

    // B) Handle client’s ack for server → client push
    socket.on('server-ack', async ({ status, id, error }) => {
      if (status === 'received') {
        console.log(`📬 Client ${socket.id} ack’d server doc ${id}`);
        try {
          await deletePending(id);
        } catch (e) {
          console.error('❌ Failed to delete pending_queue doc:', e);
        }
      } else {
        await pendingQueue.updateOne(
          { _id: new ObjectId(id) },
          { $set: { error: true, errorMessage: error } }
        );
        console.warn(`⚠️ Client ${socket.id} reported error for doc ${id}:`, status, error);
      }
      // immediately try the next pending for this socket
      serverSyncLoop(socket);
    });

    // C) When they disconnect
    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });

    // D) Kick off the server → client sync loop for this socket
    serverSyncLoop(socket);
  });

  // 4) The server → client sync loop
  async function serverSyncLoop(socket) {
    try {
      if (!socket.locationId) {
        console.warn(`⚠️ Socket ${socket.id} has no registered locationId.`);
        return;
      }

      // const doc = await getNextPending();
      const doc = await pendingQueue.findOne(
        { locationTo: socket.locationId }, // ✅ DB filters docs by location
        { sort: { _id: 1 } }
      );

      if (doc) {
        console.log(`➡️ Pushing doc ${doc._id} to client ${socket.id} (location: ${socket.locationId})`);
        socket.emit('server-sync', doc);
      } else {
        // no pending docs right now → retry after a delay
        setTimeout(() => serverSyncLoop(socket), SERVER_POLL_MS);
      }
    } catch (err) {
      console.error('❌ Error in serverSyncLoop:', err);
      // even on error, keep the loop alive
      setTimeout(() => serverSyncLoop(socket), SERVER_POLL_MS);
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => console.error('💥 Uncaught server error:', err));

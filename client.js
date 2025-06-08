// client.js
const { MongoClient, ObjectId } = require('mongodb');
const { io } = require('socket.io-client');

const LOCAL_DB_URI         = 'mongodb+srv://areduglobe:QJXetE6HydeVuOg9@areduglobedb.iwzzl.mongodb.net/imake';
const YOUR_PUBLIC_SERVER_IP = '172.235.63.132';
const SERVER_URL           = `http://${YOUR_PUBLIC_SERVER_IP}:3011`;
const POLL_INTERVAL_MS     = 2000;  // retry interval when no docs

function serializeObjectIds(obj) {
  if (Array.isArray(obj)) {
    return obj.map(serializeObjectIds);
  } else if (obj && typeof obj === 'object') {
    const newObj = {};
    for (const key in obj) {
      const val = obj[key];
      if (val instanceof ObjectId) {
        newObj[key] = { $oid: val.toHexString() };
      } else {
        newObj[key] = serializeObjectIds(val);
      }
    }
    return newObj;
  }
  return obj;
}

async function startClient() {
  // 4) Connect to local MongoDB
  const client = await MongoClient.connect(LOCAL_DB_URI, { useUnifiedTopology: true });
  console.log('🌱 Connected to local MongoDB');
  const localDb     = client.db();
  const queueColl   = localDb.collection('pending_queue');

  // 1) Connect socket
  const socket = io(SERVER_URL, { reconnection: true });

  socket.on('connect', () => {
    console.log(`✅ Connected to server: ${socket.id}`);
    syncLoop();            // start client→server sync
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected from server, will retry on reconnect');
  });

  // 2) Handle server→client pushes
  socket.on('server-sync', async (payload) => {
    const { _id: queueId, collection: collName, document: doc } = payload;
    console.log(`⬅️ Received server-sync doc ${queueId} for ${collName}:`, doc);

    try {
      const coll = localDb.collection(collName);
      const { _id, ...data } = doc;
      await coll.updateOne(
        { _id },
        { $set: data },
        { upsert: true }
      );
      console.log(`✔️ Applied server doc ${_id} to local ${collName}`);

      socket.emit('server-ack', { status: 'received', id: queueId });
    } catch (err) {
      console.error(`❌ Error applying server doc ${queueId}:`, err);
      socket.emit('server-ack', { status: 'error', id: queueId, error: err.message });
    }
  });

  // 3) Handle ack from server for our outgoing docs
  socket.on('ack', async ({ status, id }) => {
    if (status === 'saved') {
      console.log(`📬 Server ack saved for our doc ${id}`);
      await deleteLocalDoc(id);
      await syncLoop();
    } else {
      console.error(`⚠️ Server error for our doc ${id}:`, status);
      setTimeout(syncLoop, POLL_INTERVAL_MS);
    }
  });

  // helper: grab oldest pending
  async function getNextDoc() {
    return queueColl.findOne({}, { sort: { _id: 1 } });
  }

  // helper: delete after ack
  async function deleteLocalDoc(id) {
    await queueColl.deleteOne({ _id: new ObjectId(id) });
    console.log(`🗑 Deleted local pending doc ${id}`);
  }

  // 5) client→server sync loop
  async function syncLoop() {
    try {
      const doc = await getNextDoc();
      if (doc) {
        console.log('➡️ Syncing local doc to server:', doc);
        const safeDoc = serializeObjectIds(doc);
        socket.emit('sync-data', safeDoc);
      } else {
        setTimeout(syncLoop, POLL_INTERVAL_MS);
      }
    } catch (err) {
      console.error('❌ syncLoop error:', err);
      setTimeout(syncLoop, POLL_INTERVAL_MS);
    }
  }
}

startClient().catch(err => console.error('❌ Client startup error:', err));

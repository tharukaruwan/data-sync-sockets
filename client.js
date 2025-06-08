// client.js
const { MongoClient, ObjectId } = require('mongodb');
const { io } = require('socket.io-client');

const LOCAL_DB_URI         = 'mongodb+srv://areduglobe:QJXetE6HydeVuOg9@areduglobedb.iwzzl.mongodb.net/imake';
const YOUR_PUBLIC_SERVER_IP = '172.235.63.132';
const SERVER_URL           = `http://${YOUR_PUBLIC_SERVER_IP}:3011`;
const POLL_INTERVAL_MS     = 2000; // retry interval when no docs

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

async function startClient() {
  // 1) Connect to local MongoDB
  const client = await MongoClient.connect(LOCAL_DB_URI, { useUnifiedTopology: true });
  console.log('🌱 Connected to local MongoDB');
  const localDb   = client.db();
  const queueColl = localDb.collection('pending_queue');

  // 2) Helper: Get next doc to sync
  async function getNextDoc() {
    return queueColl.findOne({}, { sort: { _id: 1 } });
  }

  // 3) Helper: Delete doc after server ack
  async function deleteLocalDoc(id) {
    await queueColl.deleteOne({ _id: new ObjectId(id) });
    console.log(`🗑 Deleted local pending doc ${id}`);
  }

  // 4) Sync loop
  async function syncLoop() {
    try {
      const doc = await getNextDoc();
      if (doc) {
        console.log('➡️ Syncing local doc to server:', doc);
        socket.emit('sync-data', doc); // wait for ack
      } else {
        setTimeout(syncLoop, POLL_INTERVAL_MS);
      }
    } catch (err) {
      console.error('❌ syncLoop error:', err);
      setTimeout(syncLoop, POLL_INTERVAL_MS);
    }
  }

  // 5) Connect socket AFTER DB is ready
  const socket = io(SERVER_URL, { reconnection: true });

  socket.on('connect', () => {
    console.log(`✅ Connected to server: ${socket.id}`);
    syncLoop();
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected from server, will retry on reconnect');
  });

  // 6) Handle server→client data push
  socket.on('server-sync', async (payload) => {
    const { _id: queueId, collection: collName, document: doc } = payload;
    console.log(`⬅️ Received server-sync doc ${queueId} for ${collName}:`, doc);

    try {
      const coll = localDb.collection(collName);
      const { _id, ...data } = doc;

      await coll.updateOne(
        { _id: new ObjectId(_id) },
        { $set: convertObjectIdStrings(data) },
        { upsert: true }
      );
      console.log(`✔️ Applied server doc ${_id} to local ${collName}`);

      socket.emit('server-ack', { status: 'received', id: queueId });
    } catch (err) {
      console.error(`❌ Error applying server doc ${queueId}:`, err);
      socket.emit('server-ack', { status: 'error', id: queueId, error: err.message });
    }
  });

  // 7) Handle server ack for sent docs
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
}

startClient().catch(err => console.error('❌ Client startup error:', err));

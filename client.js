// client.js
const { MongoClient, ObjectId } = require('mongodb');
const { io } = require('socket.io-client');

const LOCAL_DB_URI         = 'mongodb+srv://areduglobe:QJXetE6HydeVuOg9@areduglobedb.iwzzl.mongodb.net/imake?retryWrites=true&w=majority';
const YOUR_PUBLIC_SERVER_IP = '172.235.63.132';
const SERVER_URL           = `http://${YOUR_PUBLIC_SERVER_IP}:3011`;
const POLL_INTERVAL_MS     = 2000;  // retry interval when no docs

function reviveObjectIds(obj) {
  if (Array.isArray(obj)) {
    return obj.map(reviveObjectIds);
  } else if (obj && typeof obj === 'object') {
    const newObj = {};
    for (const key in obj) {
      if (
        obj[key] &&
        typeof obj[key] === 'object' &&
        '$oid' in obj[key]
      ) {
        newObj[key] = new ObjectId(obj[key]['$oid']);
      } else {
        newObj[key] = reviveObjectIds(obj[key]);
      }
    }
    return newObj;
  }
  return obj;
}


async function startClient() {
  // 1) Connect to local MongoDB first
  const client = await MongoClient.connect(LOCAL_DB_URI, { useUnifiedTopology: true });
  console.log('🌱 Connected to local MongoDB');
  const localDb   = client.db();
  const queueColl = localDb.collection('pending_queue');

  // 2) Connect socket
  const socket = io(SERVER_URL, { reconnection: true });

  socket.on('connect', () => {
    console.log(`✅ Connected to server: ${socket.id}`);
    syncLoop(); // now it's safe to start sync loop
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected from server, will retry on reconnect');
  });

  // 3) Handle server→client pushes
  socket.on('server-sync', async (payload) => {
    const { _id: queueId, collection: collName, document: doc } = payload;
    console.log(`⬅️ Received server-sync doc ${queueId} for ${collName}:`, doc);

    try {
      const coll = localDb.collection(collName);
      const { _id, ...data } = doc;
      await coll.updateOne(
        { _id: new ObjectId(_id) },
        { $set: reviveObjectIds(data) },
        { upsert: true }
      );
      console.log(`✔️ Applied server doc ${_id} to local ${collName}`);

      socket.emit('server-ack', { status: 'received', id: queueId });
    } catch (err) {
      console.error(`❌ Error applying server doc ${queueId}:`, err);
      socket.emit('server-ack', { status: 'error', id: queueId, error: err.message });
    }
  });

  // 4) Handle ack from server for our outgoing docs
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
        socket.emit('sync-data', doc);
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

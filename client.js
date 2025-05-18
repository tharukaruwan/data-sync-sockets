// client.js
const { MongoClient, ObjectId } = require('mongodb');
const { io } = require('socket.io-client');

const LOCAL_DB_URI       = 'mongodb://localhost:27017/imake-test';
const YOUR_PUBLIC_SERVER_IP = 'localhost';
// Your server URL (replace with your public IP/domain)
const SERVER_URL = `http://${YOUR_PUBLIC_SERVER_IP}:3005`;

const POLL_INTERVAL_MS   = 2000;                     // retry interval when no docs

async function startClient() {
  const socket = io(SERVER_URL, { reconnection: true });

  socket.on('connect', () => {
    console.log(`✅ Connected to server: ${socket.id}`);
    // kick off the sync loop once connected
    syncLoop();
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected from server, will retry on reconnect');
  });

  // handle ack for a single doc
  socket.on('ack', async ({ status, id }) => {
    if (status === 'saved') {
      console.log(`📬 Server ack saved for doc ${id}`);
      await deleteLocalDoc(id);
      // immediately try the next doc
      await syncLoop();
    } else {
      console.error(`⚠️ Server error for doc ${id}:`, status);
      // you could choose to retry or skip
      setTimeout(syncLoop, POLL_INTERVAL_MS);
    }
  });

  // shared DB client
  const client = await MongoClient.connect(LOCAL_DB_URI);
  const db = client.db();
  const collection = db.collection('pending_queue');

  // helper: find one pending doc
  async function getNextDoc() {
    return collection.findOne({}, { sort: { _id: 1 } });
  }

  // helper: delete by _id
  async function deleteLocalDoc(id) {
    await collection.deleteOne({ _id: new ObjectId(id) });
    console.log(`🗑  Deleted local doc ${id}`);
  }

  // main sync loop
  async function syncLoop() {
    const doc = await getNextDoc();
    if (doc) {
      console.log('➡️ Syncing document:', doc);
      socket.emit('sync-data', doc);
      // wait for the 'ack' handler to delete & continue
    } else {
      // no docs right now → retry after a delay
      setTimeout(syncLoop, POLL_INTERVAL_MS);
    }
  }
}

startClient().catch(err => console.error('❌ Client error:', err));

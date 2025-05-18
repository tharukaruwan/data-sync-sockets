// client.js
const { MongoClient } = require('mongodb');
const { io } = require('socket.io-client');

// Local MongoDB URI
const LOCAL_DB_URI = 'mongodb://localhost:27017/imake-test';
const YOUR_PUBLIC_SERVER_IP = 'localhost';
// Your server URL (replace with your public IP/domain)
const SERVER_URL = `http://${YOUR_PUBLIC_SERVER_IP}:3005`;

async function startClient() {
  const socket = io(SERVER_URL, {
    reconnection: true,
    reconnectionAttempts: 5,
  });

  socket.on('connect', () => {
    console.log(`✅ Connected to server: ${socket.id}`);
  });

  socket.on('ack', (response) => {
    console.log('📬 Server acknowledgment:', response);
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
  });

  try {
    const client = await MongoClient.connect(LOCAL_DB_URI);
    console.log('🗄️ Connected to local MongoDB');
    const db = client.db();
    const collection = db.collection('pending_queue');

    const cursor = collection.find();
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      console.log('➡️ Syncing document:', doc);
      socket.emit('sync-data', doc);
    }

  } catch (err) {
    console.error('❌ Error connecting to MongoDB:', err);
  }
}

startClient();

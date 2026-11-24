const { maskName } = require('../middleware/security.middleware');

function autoArchivePastQueue(db) {
  try {
    const d = new Date();
    const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const rawQueue = db.get('queue') || [];
    let modified = false;

    rawQueue.forEach(item => {
      let itemDate = item.dateIso || (item.createdAt ? String(item.createdAt).slice(0, 10) : null);
      if (!itemDate && item.uuid) {
        try {
          const ts = parseInt(String(item.uuid).replace(/\D/g, ''), 10);
          if (ts > 1000000000000 && ts < 2500000000000) {
            const dateObj = new Date(ts);
            if (!isNaN(dateObj.getTime())) itemDate = dateObj.toISOString().slice(0, 10);
          }
        } catch (e) {}
      }
      if (!item.dateIso && itemDate) {
        item.dateIso = itemDate;
        modified = true;
      }
      if (itemDate && itemDate < todayIso && (item.stage === 'SALLE_D_ATTENTE' || item.stage === 'ARRIVE' || item.stage === 'EN_CONSULTATION')) {
        item.stage = 'TERMINE';
        modified = true;
      }
    });

    if (modified) {
      db.set('queue', rawQueue);
    }
  } catch (err) {
    console.warn('autoArchivePastQueue error:', err);
  }
}

// Real-Time WebSocket Controller for Live Waiting Room
function initQueueSocket(io, db) {
  io.on('connection', (socket) => {
    autoArchivePastQueue(db);
    console.log(`[Socket.io] 🟢 Client connected: ${socket.id}`);

    // Support room joining via handshake query
    const qDoctorId = socket.handshake.query?.doctorId;
    const qPatientId = socket.handshake.query?.patientId;
    if (qDoctorId) {
      socket.join(`doctor:${qDoctorId}`);
      socket.join(`cabinet:${qDoctorId}`);
      console.log(`[Socket.io] Client ${socket.id} joined doctor:${qDoctorId} (query)`);
    }
    if (qPatientId) {
      socket.join(`patient:${qPatientId}`);
      console.log(`[Socket.io] Client ${socket.id} joined patient:${qPatientId} (query)`);
    }

    // Join doctor-specific room & cabinet room with loop prevention
    socket.on('join:cabinet', (doctorId) => {
      if (!doctorId) return;
      const cabRoom = `cabinet:${doctorId}`;
      const docRoom = `doctor:${doctorId}`;
      if (socket.rooms && socket.rooms.has(cabRoom)) {
        return; // Already joined, avoid infinite duplicate loops
      }
      socket.join(cabRoom);
      socket.join(docRoom);
      console.log(`[Socket.io] Client ${socket.id} joined cabinet:${doctorId}`);
      const doctorQueue = (db.get('queue') || []).filter(item => item.doctorId === doctorId);
      socket.emit('queue:init', {
        queue: doctorQueue,
        delayMinutes: db.data?.delayMinutes || 0
      });
    });

    socket.on('join:doctor', (doctorId) => {
      if (!doctorId) return;
      const docRoom = `doctor:${doctorId}`;
      const cabRoom = `cabinet:${doctorId}`;
      if (socket.rooms && socket.rooms.has(docRoom)) {
        return; // Already joined, avoid infinite duplicate loops
      }
      socket.join(docRoom);
      socket.join(cabRoom);
      console.log(`[Socket.io] Client ${socket.id} joined doctor:${doctorId}`);
      const doctorQueue = (db.get('queue') || []).filter(item => item.doctorId === doctorId);
      socket.emit('queue:init', {
        queue: doctorQueue,
        delayMinutes: db.data?.delayMinutes || 0
      });
    });

    socket.on('join:patient', (patientId) => {
      if (!patientId) return;
      const patRoom = `patient:${patientId}`;
      if (socket.rooms && socket.rooms.has(patRoom)) return;
      socket.join(patRoom);
      console.log(`[Socket.io] Client ${socket.id} joined patient:${patientId}`);
    });

    socket.on('join:admin', () => {
      if (socket.rooms && socket.rooms.has('admin')) return;
      socket.join('admin');
      console.log(`[Socket.io] Client ${socket.id} joined admin room`);
    });

    // Real-Time SMS & WhatsApp Communication Handlers
    socket.on('communication:send', (data) => {
      if (!data) return;
      const targetDocId = data.doctorId || 'doc-1';
      io.to(`doctor:${targetDocId}`).to(`cabinet:${targetDocId}`).to('admin').emit('communication:sent', data);
      if (data.patientId) {
        io.to(`patient:${data.patientId}`).emit('communication:received', data);
      }
      io.emit('communication:broadcast', data);
    });

    socket.on('communication:reply', (data) => {
      if (!data) return;
      const targetDocId = data.doctorId || 'doc-1';
      io.to(`doctor:${targetDocId}`).to(`cabinet:${targetDocId}`).to('admin').emit('communication:reply', data);
      io.emit('communication:broadcast', data);
    });

    socket.on('communication:typing', (data) => {
      if (!data) return;
      const targetDocId = data.doctorId || 'doc-1';
      io.to(`doctor:${targetDocId}`).emit('communication:typing', data);
    });

    // Send initial queue state based on connection context
    const allQueue = db.get('queue') || [];
    if (qDoctorId) {
      const doctorQueue = allQueue.filter(item => item.doctorId === qDoctorId);
      socket.emit('queue:init', {
        queue: doctorQueue,
        delayMinutes: db.data?.delayMinutes || 0
      });
    } else {
      const publicQueue = allQueue.map(item => ({
        ...item,
        patientName: maskName(item.patientName)
      }));
      socket.emit('queue:init', {
        queue: publicQueue,
        delayMinutes: db.data?.delayMinutes || 0
      });
    }

    socket.on('disconnect', (reason) => {
      console.log(`[Socket.io] 🔴 Client disconnected: ${socket.id}`);
    });
  });
}

module.exports = initQueueSocket;
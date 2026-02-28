const express = require('express');
const path = require('path');
const { NeuraiLock } = require('@neuraiproject/neurai-lock');

const app = express();
app.use(express.json());

// Serve static HTML from public/
app.use(express.static(path.join(__dirname, 'public')));

// Serve the browser snippet from the neurai-lock package
app.get('/neurai-lock-client.js', (_req, res) => {
  res.sendFile(require.resolve('@neuraiproject/neurai-lock/client/neurai-lock-client.js'));
});

// Serve the example icon
app.get('/icon128.png', (_req, res) => {
  res.sendFile(path.resolve(__dirname, 'icon128.png'));
});

// NeuraiLock configured with amount: 0 so it always passes but still
// fetches real on-chain balance data to show in the UI.
const lock = new NeuraiLock({
  minXna: { amount: 0 },
});

app.post('/api/challenge', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'address is required' });
    }
    const challenge = await lock.createChallenge(address);
    res.json(challenge);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const result = await lock.verifyChallenge(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Neurai Lock example running at http://localhost:${PORT}`);
  console.log('Make sure the Neurai wallet extension is installed in Chrome.');
});

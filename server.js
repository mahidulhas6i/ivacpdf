const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Paths ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

// --- Init directories & data file ---
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PROFILES_FILE)) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify({}, null, 2));
}

// --- Helpers ---
function readProfiles() {
  return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
}

function writeProfiles(data) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2));
}

function sanitizeName(name) {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
}

// --- Middleware ---
app.use(express.json());

// Serve dashboard from root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// CORS for public fetch endpoint
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- Multer setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const profileDir = path.join(UPLOADS_DIR, req.params.name);
    fs.mkdirSync(profileDir, { recursive: true });
    cb(null, profileDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per file
});

// ===================== DASHBOARD API =====================

// List all profiles
app.get('/api/profiles', (req, res) => {
  const profiles = readProfiles();
  const list = Object.keys(profiles).map(name => ({
    name,
    pdfCount: profiles[name].pdfs.length,
    totalSize: profiles[name].pdfs.reduce((sum, p) => sum + (p.size || 0), 0),
    createdAt: profiles[name].createdAt
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  res.json(list);
});

// Create profile
app.post('/api/profiles', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Profile name is required' });
  }

  const cleanName = sanitizeName(name);
  if (!cleanName) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const profiles = readProfiles();
  if (profiles[cleanName]) {
    return res.status(409).json({ error: 'Profile already exists' });
  }

  profiles[cleanName] = {
    name: cleanName,
    pdfs: [],
    createdAt: new Date().toISOString()
  };
  writeProfiles(profiles);
  fs.mkdirSync(path.join(UPLOADS_DIR, cleanName), { recursive: true });

  res.status(201).json(profiles[cleanName]);
});

// Delete profile
app.delete('/api/profiles/:name', (req, res) => {
  const profiles = readProfiles();
  const { name } = req.params;

  if (!profiles[name]) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  const profileDir = path.join(UPLOADS_DIR, name);
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true });
  }

  delete profiles[name];
  writeProfiles(profiles);

  res.json({ message: 'Profile deleted' });
});

// Rename profile
app.put('/api/profiles/:name/rename', (req, res) => {
  const profiles = readProfiles();
  const { name } = req.params;
  const { newName } = req.body;

  if (!profiles[name]) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  if (!newName || !newName.trim()) {
    return res.status(400).json({ error: 'New name is required' });
  }

  const cleanNew = sanitizeName(newName);
  if (!cleanNew) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  if (cleanNew === name) {
    return res.json(profiles[name]);
  }

  if (profiles[cleanNew]) {
    return res.status(409).json({ error: 'A profile with that name already exists' });
  }

  // Rename folder on disk
  const oldDir = path.join(UPLOADS_DIR, name);
  const newDir = path.join(UPLOADS_DIR, cleanNew);
  if (fs.existsSync(oldDir)) {
    fs.renameSync(oldDir, newDir);
  }

  // Update profiles data
  profiles[cleanNew] = { ...profiles[name], name: cleanNew };
  delete profiles[name];
  writeProfiles(profiles);

  res.json({ message: 'Profile renamed', newName: cleanNew });
});

// Extract Application ID from PDF text
async function extractAppId(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    // Primary: match "Application Id : BGDDVC792E26" format
    const match = data.text.match(/Application\s*Id\s*:\s*([A-Z0-9]{8,20})/i);
    if (match) return match[1].toUpperCase();
    // Fallback: find standalone BGD ID pattern
    const fallback = data.text.match(/\b(BGD[A-Z0-9]{8,17})\b/);
    return fallback ? fallback[1] : null;
  } catch {
    return null;
  }
}

// Upload PDFs to profile (multiple)
app.post('/api/profiles/:name/pdfs', upload.array('pdfs', 4), async (req, res) => {
  const profiles = readProfiles();
  const { name } = req.params;
  const files = req.files || [];

  const cleanup = () => files.forEach(f => {
    if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
  });

  if (!profiles[name]) {
    cleanup();
    return res.status(404).json({ error: 'Profile not found' });
  }

  const remaining = 4 - profiles[name].pdfs.length;
  if (remaining <= 0) {
    cleanup();
    return res.status(400).json({ error: 'Maximum 4 PDFs per profile' });
  }

  if (files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  if (files.length > remaining) {
    cleanup();
    return res.status(400).json({ error: `Can only add ${remaining} more PDF(s)` });
  }

  const currentCount = profiles[name].pdfs.length;
  const existingAppIds = profiles[name].pdfs.map(p => p.appId).filter(Boolean);
  const duplicates = [];
  const accepted = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const appId = await extractAppId(file.path);

    // Check duplicate against existing profile PDFs and current batch
    if (appId && (existingAppIds.includes(appId) || accepted.some(a => a.appId === appId))) {
      duplicates.push(`${file.originalname} (${appId})`);
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      continue;
    }

    accepted.push({ file, appId });
  }

  if (accepted.length === 0 && duplicates.length > 0) {
    return res.status(400).json({ error: `Duplicate PDF(s) detected: ${duplicates.join(', ')}` });
  }

  for (let i = 0; i < accepted.length; i++) {
    const { file, appId } = accepted[i];
    const serial = currentCount + i + 1;

    let displayName;
    if (appId) {
      displayName = `${appId}_${serial}.pdf`;
    } else {
      displayName = file.originalname;
    }

    // Rename file on disk
    const newStoredName = `${serial}_${appId || Date.now()}.pdf`;
    const newPath = path.join(path.dirname(file.path), newStoredName);
    fs.renameSync(file.path, newPath);

    profiles[name].pdfs.push({
      filename: displayName,
      storedName: newStoredName,
      appId: appId || null,
      size: file.size,
      uploadedAt: new Date().toISOString()
    });
  }
  writeProfiles(profiles);

  const msg = duplicates.length > 0
    ? { ...profiles[name], warning: `Skipped duplicate(s): ${duplicates.join(', ')}` }
    : profiles[name];
  res.status(201).json(msg);
});

// Delete specific PDF and renumber remaining
app.delete('/api/profiles/:name/pdfs/:index', (req, res) => {
  const profiles = readProfiles();
  const { name, index } = req.params;
  const idx = parseInt(index);

  if (!profiles[name]) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  if (isNaN(idx) || idx < 0 || idx >= profiles[name].pdfs.length) {
    return res.status(404).json({ error: 'PDF not found' });
  }

  // Delete the file from disk
  const pdf = profiles[name].pdfs[idx];
  const filePath = path.join(UPLOADS_DIR, name, pdf.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  // Remove from array
  profiles[name].pdfs.splice(idx, 1);

  // Renumber remaining PDFs
  const profileDir = path.join(UPLOADS_DIR, name);
  for (let i = 0; i < profiles[name].pdfs.length; i++) {
    const p = profiles[name].pdfs[i];
    const serial = i + 1;
    const appId = p.appId;

    // New display name
    const newFilename = appId ? `${appId}_${serial}.pdf` : p.filename;

    // New stored name on disk
    const newStoredName = `${serial}_${appId || Date.now()}.pdf`;
    const oldPath = path.join(profileDir, p.storedName);
    const newPath = path.join(profileDir, newStoredName);

    // Rename on disk if file exists and name changed
    if (p.storedName !== newStoredName && fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, newPath);
    }

    // Update metadata
    p.filename = newFilename;
    p.storedName = newStoredName;
  }

  writeProfiles(profiles);
  res.json(profiles[name]);
});

// Replace specific PDF
app.put('/api/profiles/:name/pdfs/:index', upload.single('pdf'), async (req, res) => {
  const profiles = readProfiles();
  const { name, index } = req.params;
  const idx = parseInt(index);

  if (!profiles[name]) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Profile not found' });
  }
  if (isNaN(idx) || idx < 0 || idx >= profiles[name].pdfs.length) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'PDF not found' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const serial = idx + 1;
  const appId = await extractAppId(req.file.path);

  // Check duplicate (exclude the one being replaced)
  const existingAppIds = profiles[name].pdfs
    .filter((_, i) => i !== idx)
    .map(p => p.appId)
    .filter(Boolean);

  if (appId && existingAppIds.includes(appId)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: `Duplicate PDF: ${req.file.originalname} (${appId})` });
  }

  // Delete old file
  const oldPdf = profiles[name].pdfs[idx];
  const oldPath = path.join(UPLOADS_DIR, name, oldPdf.storedName);
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

  // Rename new file
  const displayName = appId ? `${appId}_${serial}.pdf` : req.file.originalname;
  const newStoredName = `${serial}_${appId || Date.now()}.pdf`;
  const newPath = path.join(UPLOADS_DIR, name, newStoredName);
  fs.renameSync(req.file.path, newPath);

  // Update metadata
  profiles[name].pdfs[idx] = {
    filename: displayName,
    storedName: newStoredName,
    appId: appId || null,
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };
  writeProfiles(profiles);

  res.json(profiles[name]);
});

// ===================== PUBLIC FETCH =====================

// JSON data for dashboard
app.get('/api/data/:profileName', (req, res) => {
  const profiles = readProfiles();
  const { profileName } = req.params;

  if (!profiles[profileName]) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  const profile = profiles[profileName];
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = `${proto}://${req.get('host')}`;

  const pdfs = profile.pdfs.map((pdf, i) => ({
    filename: pdf.filename,
    size: pdf.size || 0,
    downloadUrl: `${host}/${profileName}/download/${i}`,
    uploadedAt: pdf.uploadedAt
  }));

  res.json({ profile: profileName, count: pdfs.length, pdfs });
});

// GET /profilename — browser: auto-downloads all PDFs | API: returns JSON
app.get('/:profileName', (req, res) => {
  const profiles = readProfiles();
  const { profileName } = req.params;

  if (!profiles[profileName]) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  const profile = profiles[profileName];
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = `${proto}://${req.get('host')}`;

  const pdfs = profile.pdfs.map((pdf, i) => ({
    filename: pdf.filename,
    size: pdf.size || 0,
    downloadUrl: `${host}/${profileName}/download/${i}`,
    uploadedAt: pdf.uploadedAt
  }));

  // API client (Python, curl, etc.) — return JSON
  if (req.accepts('json') && !req.accepts('html')) {
    return res.json({ profile: profileName, count: pdfs.length, pdfs });
  }

  // Browser — auto-download HTML page
  if (profile.pdfs.length === 0) {
    return res.send('<h3>No PDFs in this profile.</h3>');
  }

  const downloadLinks = pdfs.map(p => p.downloadUrl);

  res.send(`<!DOCTYPE html>
<html><head><title>Downloading ${profileName}</title></head>
<body>
<p>Downloading ${profile.pdfs.length} PDF(s)...</p>
<script>
  const links = ${JSON.stringify(downloadLinks)};
  links.forEach((url, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 500);
  });
</script>
</body></html>`);
});

// Download individual PDF file
app.get('/:profileName/download/:index', (req, res) => {
  const profiles = readProfiles();
  const { profileName, index } = req.params;
  const idx = parseInt(index);

  if (!profiles[profileName]) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  if (isNaN(idx) || idx < 0 || idx >= profiles[profileName].pdfs.length) {
    return res.status(404).json({ error: 'PDF not found' });
  }

  const pdf = profiles[profileName].pdfs[idx];
  const filePath = path.join(UPLOADS_DIR, profileName, pdf.storedName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  res.download(filePath, pdf.filename);
});

// View PDF inline in browser
app.get('/:profileName/view/:index', (req, res) => {
  const profiles = readProfiles();
  const { profileName, index } = req.params;
  const idx = parseInt(index);

  if (!profiles[profileName]) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  if (isNaN(idx) || idx < 0 || idx >= profiles[profileName].pdfs.length) {
    return res.status(404).json({ error: 'PDF not found' });
  }

  const pdf = profiles[profileName].pdfs[idx];
  const filePath = path.join(UPLOADS_DIR, profileName, pdf.storedName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// --- Error handler for multer ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Max 10MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`PDF Profile Server running on port ${PORT}`);
});

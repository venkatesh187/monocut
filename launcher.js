const { exec, spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_URL = `http://localhost:${PORT}`;

// Start the backend server
const serverProcess = spawn('node', [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  shell: true
});

function checkServerReady(retries = 20) {
  if (retries <= 0) {
    console.error('Server failed to start in time.');
    return;
  }

  http.get(APP_URL, (res) => {
    console.log(`\n>>> MonoCut Editor is active at ${APP_URL}`);
    launchAppWindow(APP_URL);
  }).on('error', () => {
    setTimeout(() => checkServerReady(retries - 1), 300);
  });
}

function launchAppWindow(url) {
  // Try Microsoft Edge App Mode (default on Windows 10/11)
  const edgeCmd = `start msedge --app="${url}" --window-size=1280,820`;
  const chromeCmd = `start chrome --app="${url}" --window-size=1280,820`;
  const defaultCmd = `start ${url}`;

  exec(edgeCmd, (err) => {
    if (err) {
      exec(chromeCmd, (err2) => {
        if (err2) {
          exec(defaultCmd);
        }
      });
    }
  });
}

setTimeout(checkServerReady, 500);

process.on('SIGINT', () => {
  serverProcess.kill();
  process.exit();
});
